//! index.ts 3173-3720: element fonts, deck-wide find/replace and paragraph
//! formatting (bullet, spacing, alignment, direction, indent level).

use std::collections::{BTreeSet, HashSet};

use jscompat::{JsNum, math_max, math_min};
use serde::{Deserialize, Deserializer, Serialize};

use crate::deck::{edit_table_cell_text, patch_group_child_text, patch_group_child_xml};
use crate::generate::{hangul_lang, patch_element_p_pr, rebuild_tx_body, tag_hangul_run};
use crate::placeholder::BulletType;
use crate::types::{
    PPrDirty, Paragraph, ParagraphBullet, Slide, SlideDeck, SlideElement, TextAlign, TextElement,
    TextRun,
};
use crate::with_element;

/// `undefined` as `None`, `null` as `Some(None)`.
fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(deserializer).map(Some)
}

fn element_index(slide: &Slide, element_id: &str) -> Option<usize> {
    slide
        .elements
        .as_deref()?
        .iter()
        .position(|e| e.id() == element_id)
}

fn element_at(slide: &mut Slide, index: usize) -> Option<&mut SlideElement> {
    slide.elements.as_mut()?.get_mut(index)
}

/// `t.text?.paragraphs`
fn paragraphs_of(el: &mut TextElement) -> Option<&mut Vec<Paragraph>> {
    el.text.as_mut()?.paragraphs.as_mut()
}

/// The lengths of the rows of the table at `index`.
fn row_lengths(slide: &Slide, index: usize) -> Vec<usize> {
    match slide.elements.as_deref().and_then(|els| els.get(index)) {
        Some(SlideElement::Table(t)) => t
            .rows
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .map(Vec::len)
            .collect(),
        _ => Vec::new(),
    }
}

/// The paragraphs of cell (`r`, `c`) of the table at `index`; `None` for a
/// merged cell or one without paragraphs (the TypeScript skips both).
fn cell_paragraphs(
    slide: &mut Slide,
    index: usize,
    r: usize,
    c: usize,
) -> Option<&mut Vec<Paragraph>> {
    let SlideElement::Table(t) = element_at(slide, index)? else {
        return None;
    };
    let cell = t.rows.as_mut()?.get_mut(r)?.get_mut(c)?;
    if cell.merged.unwrap_or(false) {
        return None;
    }
    let paragraphs = cell.text.as_mut()?.paragraphs.as_mut()?;
    if paragraphs.is_empty() {
        return None;
    }
    Some(paragraphs)
}

/// `paragraphs[i]` for a number: only a non-negative integer below the length finds one.
fn paragraph_index(i: f64, len: usize) -> Option<usize> {
    (i.fract() == 0.0 && i >= 0.0 && i < len as f64).then_some(i as usize)
}

// ── Fonts ───────────────────────────────────────────────────────────────

/// Elements without text (pictures/charts etc.) return false.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementFontPatch {
    pub font_family: Option<String>,
    pub font_size_pt: Option<f64>,
    pub strike: Option<bool>,
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub underline: Option<bool>,
    /// #RRGGBB (explicit color: clears theme-link/inheritance flags)
    pub color: Option<String>,
    /// Text highlight #RRGGBB; null removes it
    #[serde(default, deserialize_with = "nullable")]
    pub highlight: Option<Option<String>>,
    /// Letter spacing in points (negative = tighter); null or 0 = normal spacing
    #[serde(default, deserialize_with = "nullable")]
    pub letter_spacing_pt: Option<Option<f64>>,
}

/// `FontSizeMap`: per-run size rewrite (relative grow/shrink); `None` = the
/// run inherits its size.
pub type FontSizeMap<'a> = &'a dyn Fn(Option<f64>) -> f64;

/// `applyFontPatch`
pub(crate) fn apply_font_patch(
    paragraphs: &mut [Paragraph],
    patch: &ElementFontPatch,
    size_map: Option<FontSizeMap<'_>>,
) {
    for p in paragraphs.iter_mut() {
        let Some(runs) = p.runs.as_mut() else {
            continue;
        };
        // Empty paragraph (e.g. a blank table cell): leave an empty marker run so the
        // format persists and text typed later inherits it
        if runs.is_empty() {
            let mut marker = TextRun::default();
            marker.text.set(String::new());
            runs.push(marker);
        }
        for r in runs.iter_mut() {
            if let Some(family) = &patch.font_family {
                r.font_family.set(family.clone());
                // User explicitly changed the font: the original latin/ea/cs keep-flags no longer
                // apply, write the new font back. csFont has to go with them or a rebuilt run
                // re-emits the old complex-script typeface and Arabic text never changes.
                r.latin_font.delete();
                r.ea_font.delete();
                r.cs_font.delete();
                r.font_implicit.delete();
                r.latin_family.delete();
            }
            if patch.font_size_pt.is_some() || size_map.is_some() {
                let size = match size_map {
                    Some(map) => Some(map((*r.font_size).map(|n| n.0))),
                    None => patch.font_size_pt,
                };
                r.font_size.assign(size.map(JsNum));
                r.font_size_implicit.delete();
            }
            if let Some(strike) = patch.strike {
                r.strike.set(strike);
                // Explicit off must survive a rebuild as strike="noStrike" (see buildRPrAttrs)
                if !strike {
                    r.strike_style.delete();
                    r.strike_explicit_none.set(true);
                } else {
                    r.strike_explicit_none.delete();
                }
            }
            if let Some(bold) = patch.bold {
                r.bold.set(bold);
                r.bold_implicit.delete();
            }
            if let Some(italic) = patch.italic {
                r.italic.set(italic);
                r.italic_implicit.delete();
            }
            if let Some(underline) = patch.underline {
                r.underline.set(underline);
                if !underline {
                    r.underline_style.delete();
                    r.underline_explicit_none.set(true);
                } else {
                    r.underline_explicit_none.delete();
                }
            }
            if let Some(color) = &patch.color {
                r.color.set(color.clone());
                r.color_follows_theme.delete();
                r.color_inherited.delete();
                r.color_node_xml.delete();
            }
            if let Some(highlight) = &patch.highlight {
                match highlight.as_deref().filter(|h| !h.is_empty()) {
                    Some(h) => r.highlight.set(h.to_owned()),
                    None => r.highlight.delete(),
                }
                r.highlight_edited.set(true);
            }
            if let Some(spacing) = &patch.letter_spacing_pt {
                match spacing.filter(|s| *s != 0.0 && !s.is_nan()) {
                    Some(s) => r.letter_spacing.set(JsNum(s)),
                    None => r.letter_spacing.delete(),
                }
                r.letter_spacing_edited.set(true);
            }
        }
    }
}

/// Change the font of a text, shape or table element: every run of every
/// paragraph (every non-merged cell of a table).
pub fn set_element_font(
    slide: &mut Slide,
    element_id: &str,
    patch: &ElementFontPatch,
    size_map: Option<FontSizeMap<'_>>,
) -> Result<bool, String> {
    let Some(index) = element_index(slide, element_id) else {
        return Ok(false);
    };
    match element_at(slide, index) {
        Some(SlideElement::Text(t)) => {
            let Some(paragraphs) = paragraphs_of(t).filter(|p| !p.is_empty()) else {
                return Ok(false);
            };
            apply_font_patch(paragraphs, patch, size_map);
            t.dirty.set(true);
            Ok(true)
        }
        Some(SlideElement::Table(_)) => {
            let mut changed = false;
            for (r, len) in row_lengths(slide, index).into_iter().enumerate() {
                for c in 0..len {
                    let Some(paragraphs) = cell_paragraphs(slide, index, r, c) else {
                        continue;
                    };
                    apply_font_patch(paragraphs, patch, size_map);
                    let edited = paragraphs.clone();
                    if edit_table_cell_text(slide, element_id, r as f64, c as f64, &edited) {
                        changed = true;
                    }
                }
            }
            Ok(changed)
        }
        _ => Ok(false),
    }
}

// ── Find/replace ────────────────────────────────────────────────────────

/// `ReplaceOptions`
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceOptions {
    pub match_case: Option<bool>,
    /// Replace only the first match (the "Replace" button; default replaces all)
    pub first_only: Option<bool>,
    /// Restrict to one slide/element (the "Replace" button acts on the currently hit element)
    pub slide_index: Option<f64>,
    pub element_id: Option<String>,
    /// Text a person hid from AI is out of the search: no match inside it or
    /// across it, and no count for one. For an agent, whose answer would
    /// otherwise tell it the words are there.
    pub skip_withheld: Option<bool>,
}

/// What `replaceAllInDeck` answers.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResult {
    pub count: usize,
    pub changed_slides: Vec<usize>,
}

/// The literal search the TypeScript builds as `new RegExp(escape(find), 'g' or 'gi')`,
/// over UTF-16 code units. `i` without `u` compares `Canonicalize(unit)`: the
/// single-unit upper case of the unit, never mapping a non-ASCII unit to ASCII.
struct Needle {
    units: Vec<u16>,
    fold: bool,
}

/// ECMAScript `Canonicalize` of a code unit under `i` without `u`.
fn canonicalize(unit: u16) -> u16 {
    let Some(c) = char::from_u32(u32::from(unit)) else {
        return unit; // a surrogate half
    };
    let mut upper = c.to_uppercase();
    let (Some(first), None) = (upper.next(), upper.next()) else {
        return unit; // not exactly one character: ch is kept
    };
    match u16::try_from(u32::from(first)) {
        Ok(cu) if !(unit >= 128 && cu < 128) => cu,
        _ => unit,
    }
}

impl Needle {
    fn new(find: &str, match_case: bool) -> Self {
        let mut units: Vec<u16> = find.encode_utf16().collect();
        if !match_case {
            for u in &mut units {
                *u = canonicalize(*u);
            }
        }
        Self {
            units,
            fold: !match_case,
        }
    }

    /// `re.exec(full)` from `from`: the index of the first match.
    fn find_at(&self, full: &[u16], from: usize) -> Option<usize> {
        let m = self.units.len();
        if m == 0 {
            return None;
        }
        let last = full.len().checked_sub(m)?;
        (from..=last).find(|&i| {
            full.get(i..i + m).is_some_and(|window| {
                window.iter().zip(&self.units).all(|(&a, &b)| {
                    if self.fold {
                        canonicalize(a) == b
                    } else {
                        a == b
                    }
                })
            })
        })
    }
}

struct Replacer {
    needle: Needle,
    replace: Vec<u16>,
    /// `hangulLang(replace) !== undefined`
    korean_replace: bool,
    /// `Infinity` or 1
    budget: f64,
    count: usize,
    /// `opts.skipWithheld === true`
    skip_withheld: bool,
}

/// `isBarrier`: a field run or an <a:br/> soft-break sentinel is a hard
/// barrier, and so is a run hidden from AI when the search skips those.
fn is_barrier(r: &TextRun, skip_withheld: bool) -> bool {
    r.field.as_deref().is_some_and(|f| !f.is_empty())
        || r.text.as_deref() == Some("\n")
        || (skip_withheld && r.redact.as_deref().is_some_and(|label| !label.is_empty()))
}

/// `segmentsOf`: matches may only span the consecutive plain runs between barriers.
fn segments_of(p: &Paragraph, skip_withheld: bool) -> Vec<Vec<usize>> {
    let mut segments: Vec<Vec<usize>> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    for (i, r) in p.runs.as_deref().unwrap_or(&[]).iter().enumerate() {
        if is_barrier(r, skip_withheld) {
            if !current.is_empty() {
                segments.push(std::mem::take(&mut current));
            }
        } else if r.text.as_deref().is_some_and(|t| !t.is_empty()) {
            current.push(i);
        }
    }
    if !current.is_empty() {
        segments.push(current);
    }
    segments
}

impl Replacer {
    /// `replaceInRuns`: the new text of each run and which runs a replacement
    /// landed in (`landed`), `None` when nothing matched.
    fn replace_in_runs(&mut self, texts: &[&str]) -> Option<(Vec<String>, Vec<bool>)> {
        let mut full: Vec<u16> = Vec::new();
        let mut ends: Vec<usize> = Vec::with_capacity(texts.len());
        for t in texts {
            full.extend(t.encode_utf16());
            ends.push(full.len());
        }
        let mut out: Vec<Vec<u16>> = texts.iter().map(|_| Vec::new()).collect();
        let run_at = |offset: usize| -> usize {
            ends.iter()
                .position(|&end| offset < end)
                .unwrap_or(ends.len().saturating_sub(1))
        };
        let keep = |out: &mut Vec<Vec<u16>>, from: usize, to: usize| {
            let mut off = from;
            for (k, &end) in ends.iter().enumerate() {
                if off >= to {
                    break;
                }
                if end <= off {
                    continue;
                }
                let take = end.min(to) - off;
                if let (Some(piece), Some(dest)) = (full.get(off..off + take), out.get_mut(k)) {
                    dest.extend_from_slice(piece);
                }
                off += take;
            }
        };
        let mut cursor = 0;
        let mut n = 0;
        let mut landed = vec![false; texts.len()];
        while self.budget > 0.0 {
            let Some(at) = self.needle.find_at(&full, cursor) else {
                break;
            };
            n += 1;
            self.budget -= 1.0;
            keep(&mut out, cursor, at);
            let landing = run_at(at);
            if let Some(dest) = out.get_mut(landing) {
                dest.extend_from_slice(&self.replace);
            }
            if let Some(flag) = landed.get_mut(landing) {
                *flag = true;
            }
            cursor = at + self.needle.units.len();
        }
        if n == 0 {
            return None;
        }
        keep(&mut out, cursor, full.len());
        self.count += n;
        Some((
            out.into_iter()
                .map(|units| String::from_utf16_lossy(&units))
                .collect(),
            landed,
        ))
    }

    /// One segment of runs of a paragraph: true when something was replaced.
    fn replace_in_segment(&mut self, p: &mut Paragraph, segment: &[usize]) -> bool {
        let out = {
            let runs = p.runs.as_deref().unwrap_or(&[]);
            let texts: Vec<&str> = segment
                .iter()
                .map(|&i| {
                    runs.get(i)
                        .and_then(|r| r.text.as_deref())
                        .unwrap_or_default()
                })
                .collect();
            self.replace_in_runs(&texts)
        };
        let Some((out, landed)) = out else {
            return false;
        };
        if let Some(runs) = p.runs.as_mut() {
            for ((&i, new_text), landed) in segment.iter().zip(out).zip(landed) {
                if let Some(r) = runs.get_mut(i) {
                    if r.text.as_deref() != Some(new_text.as_str()) {
                        r.text.set(new_text);
                    }
                    // Hangul written into a run with no language of its own gets PowerPoint's ko-KR
                    if self.korean_replace && landed {
                        *r = tag_hangul_run(r);
                    }
                }
            }
        }
        true
    }

    /// `replaceInParagraphs`
    fn replace_in_paragraphs(&mut self, paragraphs: &mut [Paragraph]) -> bool {
        let mut hit = false;
        for p in paragraphs.iter_mut() {
            if self.budget <= 0.0 {
                return hit;
            }
            for segment in segments_of(p, self.skip_withheld) {
                if self.budget <= 0.0 {
                    return hit;
                }
                hit = self.replace_in_segment(p, &segment) || hit;
            }
        }
        hit
    }
}

/// Deck-wide replace (a match may span consecutive runs of a paragraph: the
/// replacement lands in the run holding its first character and the matched text
/// is cut from the runs it covers, so untouched text keeps its own rPr). Covers
/// text/shape, table cells, and direct group children; dynamic field runs are
/// skipped and no match spans one.
/// Returns the replacement count; elements on changed slides are flagged dirty.
///
/// The search is a literal: the TypeScript escapes `find` into a RegExp, and
/// `replace` is appended as it is (no `$` pattern is expanded). A literal search
/// over UTF-16 units is what that RegExp does, `i` flag included, without the
/// regex engine (which refuses a pattern of a non-BMP or cased non-ASCII letter).
pub fn replace_all_in_deck(
    deck: &mut SlideDeck,
    find: &str,
    replace: &str,
    opts: &ReplaceOptions,
) -> Result<ReplaceResult, String> {
    if find.is_empty() {
        return Ok(ReplaceResult {
            count: 0,
            changed_slides: Vec::new(),
        });
    }
    let mut replacer = Replacer {
        needle: Needle::new(find, opts.match_case == Some(true)),
        replace: replace.encode_utf16().collect(),
        korean_replace: hangul_lang(replace).is_some(),
        budget: if opts.first_only == Some(true) {
            1.0
        } else {
            f64::INFINITY
        },
        count: 0,
        skip_withheld: opts.skip_withheld == Some(true),
    };
    let mut changed: BTreeSet<usize> = BTreeSet::new();

    for (si, slide) in deck.slides.iter_mut().enumerate() {
        if replacer.budget <= 0.0 {
            continue;
        }
        if opts.slide_index.is_some_and(|wanted| si as f64 != wanted) {
            continue;
        }
        let count = slide.elements.as_deref().map_or(0, <[SlideElement]>::len);
        for ei in 0..count {
            if replacer.budget <= 0.0 {
                break;
            }
            let (id, kind) = match element_at(slide, ei) {
                Some(el) => (
                    el.id().to_owned(),
                    match el {
                        SlideElement::Text(t) => {
                            if t.text.is_some() {
                                1
                            } else {
                                0
                            }
                        }
                        SlideElement::Table(_) => 2,
                        SlideElement::Group(_) => 3,
                        _ => 0,
                    },
                ),
                None => break,
            };
            if opts
                .element_id
                .as_deref()
                .is_some_and(|wanted| id != wanted)
            {
                continue;
            }
            match kind {
                1 => {
                    if let Some(SlideElement::Text(t)) = element_at(slide, ei) {
                        let hit = paragraphs_of(t)
                            .is_some_and(|paragraphs| replacer.replace_in_paragraphs(paragraphs));
                        if hit {
                            t.dirty.set(true);
                            changed.insert(si);
                        }
                    }
                }
                2 => {
                    let rows = row_lengths(slide, ei);
                    'rows: for (ri, len) in rows.into_iter().enumerate() {
                        for ci in 0..len {
                            if let Some(paragraphs) = cell_paragraphs(slide, ei, ri, ci) {
                                if replacer.replace_in_paragraphs(paragraphs) {
                                    let edited = paragraphs.clone();
                                    edit_table_cell_text(slide, &id, ri as f64, ci as f64, &edited);
                                    changed.insert(si);
                                }
                                if replacer.budget <= 0.0 {
                                    break;
                                }
                            }
                        }
                        if replacer.budget <= 0.0 {
                            break 'rows;
                        }
                    }
                }
                3 => {
                    let children = match element_at(slide, ei) {
                        Some(SlideElement::Group(g)) => {
                            g.children.as_deref().map_or(0, <[SlideElement]>::len)
                        }
                        _ => 0,
                    };
                    for ci in 0..children {
                        if replacer.budget <= 0.0 {
                            break;
                        }
                        let patched: Option<TextElement> = match element_at(slide, ei) {
                            Some(SlideElement::Group(g)) => {
                                match g.children.as_mut().and_then(|c| c.get_mut(ci)) {
                                    Some(SlideElement::Text(child)) if child.text.is_some() => {
                                        let hit = paragraphs_of(child).is_some_and(|paragraphs| {
                                            replacer.replace_in_paragraphs(paragraphs)
                                        });
                                        hit.then(|| (**child).clone())
                                    }
                                    _ => None,
                                }
                            }
                            _ => None,
                        };
                        if let Some(child) = patched {
                            patch_group_child_text(slide, &id, &child)?;
                            changed.insert(si);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    Ok(ReplaceResult {
        count: replacer.count,
        changed_slides: changed.into_iter().collect(),
    })
}

// ── Paragraph formatting (bullet/line spacing/paragraph spacing/alignment) ──

jscompat::js_object! {
    deserialize;
    /// `bulletBlip` of a `ParagraphFormatPatch`: a picture bullet that already
    /// landed in the package (media path + slide rId). Its keys spread in the
    /// order the caller wrote them.
    #[derive(Debug, Clone, PartialEq)]
    pub struct BulletBlip {
        pub media_ref: String,
        pub blip_embed_id: String,
    }
}

/// `ParagraphFormatPatch`
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParagraphFormatPatch {
    /// 'char' round bullet / 'number' numbering / 'blip' picture / 'none' explicitly none
    pub bullet: Option<String>,
    /// buAutoNum scheme (ST_TextAutonumberScheme) with bullet: 'number'; alone it re-schemes numbered paragraphs
    pub num_type: Option<String>,
    /// First number of the sequence; alone it only touches numbered paragraphs
    pub start_at: Option<f64>,
    /// Picture bullet already landed in the package, with bullet: 'blip'
    pub bullet_blip: Option<BulletBlip>,
    /// Custom bullet character (with bullet: 'char'; defaults to a round bullet)
    pub bullet_char: Option<String>,
    /// <a:buFont> for the character
    pub bullet_font: Option<String>,
    /// Bullet hanging indent (EMU); alone it adjusts existing bullets' indent
    pub bullet_hang_emu: Option<f64>,
    /// Bullet size (% of text size, 100 = same); alone it only touches bulleted paragraphs
    pub bullet_size_pct: Option<f64>,
    /// Bullet color (#RRGGBB); alone it only touches bulleted paragraphs
    pub bullet_color: Option<String>,
    /// Line spacing (%, 100 = single)
    pub line_spacing_pct: Option<f64>,
    /// Space before / after (pt)
    pub space_before_pt: Option<f64>,
    pub space_after_pt: Option<f64>,
    pub align: Option<TextAlign>,
    /// Paragraph base direction (a:pPr rtl); false writes an explicit rtl="0"
    pub rtl: Option<bool>,
    /// Indent level delta (multi-level list Tab/Shift+Tab; clamp 0..8)
    pub indent_delta: Option<f64>,
}

/// Hanging indent PowerPoint writes when bulleting a plain text box (0.3125in)
const BULLET_HANG_EMU: f64 = 285750.0;

/// A key of `pPrExplicit`.
#[derive(Clone, Copy)]
enum Mark {
    Bullet,
    MarL,
    Indent,
    LnSpc,
    SpcBef,
    SpcAft,
    Align,
}

/// Missing pPrExplicit = newly created element (all-explicit semantics); change values only,
/// don't build the flag table.
fn mark(p: &mut Paragraph, key: Mark) {
    if let Some(explicit) = p.p_pr_explicit.as_mut() {
        match key {
            Mark::Bullet => explicit.bullet.set(true),
            Mark::MarL => explicit.mar_l.set(true),
            Mark::Indent => explicit.indent.set(true),
            Mark::LnSpc => explicit.ln_spc.set(true),
            Mark::SpcBef => explicit.spc_bef.set(true),
            Mark::SpcAft => explicit.spc_aft.set(true),
            Mark::Align => explicit.align.set(true),
        }
    }
}

/// `kept` of applyParagraphFormat: the color and size of the previous bullet.
struct Kept {
    color: Option<String>,
    color_node_xml: Option<String>,
    size_pct: Option<JsNum>,
    size_pt: Option<JsNum>,
}

impl Kept {
    fn of(prev: Option<&ParagraphBullet>) -> Self {
        Self {
            color: prev
                .and_then(|b| b.color.as_deref())
                .filter(|c| !c.is_empty())
                .map(str::to_owned),
            color_node_xml: prev
                .and_then(|b| b.color_node_xml.as_deref())
                .filter(|c| !c.is_empty())
                .map(str::to_owned),
            size_pct: prev.and_then(|b| *b.size_pct),
            size_pt: prev.and_then(|b| *b.size_pt),
        }
    }

    /// `...kept`
    fn spread(&self, b: &mut ParagraphBullet) {
        if let Some(c) = &self.color {
            b.color.set(c.clone());
        }
        if let Some(c) = &self.color_node_xml {
            b.color_node_xml.set(c.clone());
        }
        if let Some(n) = self.size_pct {
            b.size_pct.set(n);
        }
        if let Some(n) = self.size_pt {
            b.size_pt.set(n);
        }
    }
}

/// `p.bullet && p.bullet.type !== 'none'`
fn rendered_bullet(p: &Paragraph) -> Option<&ParagraphBullet> {
    p.bullet
        .as_ref()
        .filter(|b| *b.r#type != Some(BulletType::None))
}

/// `p.indent != null && p.indent < 0`
fn hanging(p: &Paragraph) -> bool {
    p.indent.is_some_and(|i| i.0 < 0.0)
}

/// `(p.level ?? 0)`
fn level_of(p: &Paragraph) -> f64 {
    p.level.map_or(0.0, |l| l.0)
}

/// One paragraph of `applyParagraphFormat`.
fn apply_to_paragraph(p: &mut Paragraph, patch: &ParagraphFormatPatch, dirty: &mut PPrDirty) {
    let bullet_kind = patch.bullet.as_deref().filter(|k| !k.is_empty());
    if let Some(kind) = bullet_kind {
        if kind == "none" {
            let mut none = ParagraphBullet::default();
            none.r#type.set(BulletType::None);
            p.bullet.set(none);
            // Removing the bullet also retracts the hanging indent
            p.mar_l.set(JsNum(0.0));
            p.indent.set(JsNum(0.0));
            mark(p, Mark::MarL);
            mark(p, Mark::Indent);
            dirty.indents.set(true);
        } else {
            // Keep the existing bullet's color/size when only the kind or glyph changes; the
            // font follows the glyph (a Wingdings code picked from the gallery brings its font,
            // a plain character drops a stale symbol font)
            let prev: Option<ParagraphBullet> = rendered_bullet(p).cloned();
            let kept = Kept::of(prev.as_ref());
            let font: Option<String> =
                if patch.bullet_char.as_deref().is_some_and(|c| !c.is_empty()) {
                    patch.bullet_font.clone()
                } else {
                    patch
                        .bullet_font
                        .clone()
                        .or_else(|| prev.as_ref().and_then(|b| (*b.font).clone()))
                };
            if kind == "number" {
                let prev_num = prev
                    .as_ref()
                    .filter(|b| *b.r#type == Some(BulletType::Number));
                let start_at: Option<JsNum> = patch
                    .start_at
                    .map(JsNum)
                    .or_else(|| prev_num.and_then(|b| *b.start_at));
                let mut b = ParagraphBullet::default();
                b.r#type.set(BulletType::Number);
                b.num_type.set(
                    patch
                        .num_type
                        .clone()
                        .or_else(|| prev_num.and_then(|b| (*b.num_type).clone()))
                        .unwrap_or_else(|| "arabicPeriod".to_owned()),
                );
                if let Some(n) = start_at {
                    b.start_at.set(n);
                }
                kept.spread(&mut b);
                p.bullet.set(b);
            } else if let (true, Some(blip)) = (kind == "blip", &patch.bullet_blip) {
                let mut b = ParagraphBullet::default();
                b.r#type.set(BulletType::Blip);
                // ...patch.bulletBlip: its keys in the caller's order
                for key in blip.keys() {
                    match key {
                        "mediaRef" => b.media_ref.assign((*blip.media_ref).clone()),
                        "blipEmbedId" => b.blip_embed_id.assign((*blip.blip_embed_id).clone()),
                        _ => {}
                    }
                }
                kept.spread(&mut b);
                p.bullet.set(b);
            } else {
                let mut b = ParagraphBullet::default();
                b.r#type.set(BulletType::Char);
                b.char.set(
                    patch
                        .bullet_char
                        .clone()
                        .unwrap_or_else(|| "\u{2022}".to_owned()),
                );
                kept.spread(&mut b);
                if let Some(f) = font.filter(|f| !f.is_empty()) {
                    b.font.set(f);
                }
                p.bullet.set(b);
            }
            // Add the default hanging indent when absent (stepped by level);
            // an explicit bulletHangEmu always re-applies
            let hang = patch.bullet_hang_emu.unwrap_or(BULLET_HANG_EMU);
            if patch.bullet_hang_emu.is_some() || !hanging(p) {
                let mar_l = hang * (level_of(p) + 1.0);
                p.mar_l.set(JsNum(mar_l));
                p.indent.set(JsNum(-hang));
                mark(p, Mark::MarL);
                mark(p, Mark::Indent);
                dirty.indents.set(true);
            }
        }
        mark(p, Mark::Bullet);
        dirty.bullet.set(true);
    } else if let Some(hang) = patch.bullet_hang_emu {
        // Standalone hang adjustment: only touches paragraphs that render a bullet
        if rendered_bullet(p).is_some() || hanging(p) {
            let mar_l = hang * (level_of(p) + 1.0);
            p.mar_l.set(JsNum(mar_l));
            p.indent.set(JsNum(-hang));
            mark(p, Mark::MarL);
            mark(p, Mark::Indent);
            dirty.indents.set(true);
        }
    }
    if bullet_kind.is_none() && (patch.num_type.is_some() || patch.start_at.is_some()) {
        // Standalone scheme / start number: only touches numbered paragraphs
        let numbered = p
            .bullet
            .as_ref()
            .is_some_and(|b| *b.r#type == Some(BulletType::Number));
        if numbered {
            if let Some(b) = p.bullet.as_mut() {
                if let Some(num_type) = &patch.num_type {
                    b.num_type.set(num_type.clone());
                }
                if let Some(start_at) = patch.start_at {
                    b.start_at.set(JsNum(start_at));
                }
            }
            mark(p, Mark::Bullet);
            dirty.bullet.set(true);
        }
    }
    let bullet_color = patch.bullet_color.as_deref().filter(|c| !c.is_empty());
    if patch.bullet_size_pct.is_some() || bullet_color.is_some() {
        // Standalone size/color adjustment: only touches paragraphs that render a bullet
        if rendered_bullet(p).is_some() {
            if let Some(b) = p.bullet.as_mut() {
                if let Some(size) = patch.bullet_size_pct {
                    b.size_pct.set(JsNum(size));
                    b.size_pt.delete();
                }
                if let Some(color) = bullet_color {
                    b.color.set(color.to_owned());
                    // a user color replaces the captured theme node, else generate re-emits the old schemeClr
                    b.color_node_xml.delete();
                }
            }
            mark(p, Mark::Bullet);
            dirty.bullet.set(true);
        }
    }
    if let Some(pct) = patch.line_spacing_pct {
        p.line_height.set(JsNum(pct));
        p.line_exact.delete();
        mark(p, Mark::LnSpc);
        dirty.ln_spc.set(true);
    }
    if let Some(pt) = patch.space_before_pt {
        p.space_before.set(JsNum(pt));
        p.space_before_pct.delete();
        mark(p, Mark::SpcBef);
        dirty.spc_bef.set(true);
    }
    if let Some(pt) = patch.space_after_pt {
        p.space_after.set(JsNum(pt));
        p.space_after_pct.delete();
        mark(p, Mark::SpcAft);
        dirty.spc_aft.set(true);
    }
    if let Some(align) = patch.align {
        p.align.set(align);
        mark(p, Mark::Align);
        dirty.align.set(true);
    }
    if let Some(rtl) = patch.rtl {
        p.rtl.set(rtl);
        dirty.rtl.set(true);
    }
    if let Some(delta) = patch.indent_delta.filter(|d| *d != 0.0 && !d.is_nan()) {
        let current = level_of(p);
        let lvl = math_max(0.0, math_min(8.0, current + delta));
        if lvl != current {
            p.level
                .assign((lvl != 0.0 && !lvl.is_nan()).then_some(JsNum(lvl)));
            dirty.level.set(true);
            // Own-bullet hanging indent steps with the level; inherited indents are left to the materialize reparse
            let own_mar_l = p
                .p_pr_explicit
                .as_ref()
                .is_some_and(|x| x.mar_l.unwrap_or(false));
            if own_mar_l && hanging(p) {
                let indent = p.indent.map_or(f64::NAN, |i| i.0);
                p.mar_l.set(JsNum(-indent * (lvl + 1.0)));
                dirty.indents.set(true);
            }
        }
    }
}

/// Apply a paragraph-format patch to model paragraphs in place. Exported for
/// callers that rebuild a text body themselves (table cell edits) and need the
/// same bullet/spacing/direction semantics as setElementParagraphFormat without
/// its element-wide scope.
pub fn apply_paragraph_format(
    paragraphs: &mut [Paragraph],
    patch: &ParagraphFormatPatch,
) -> PPrDirty {
    let mut dirty = PPrDirty::default();
    for p in paragraphs.iter_mut() {
        apply_to_paragraph(p, patch, &mut dirty);
    }
    dirty
}

/// `[...new Set([...a, ...b])]`: SameValueZero, so -0 becomes 0.
fn union_indices(a: &[JsNum], b: &[JsNum]) -> Vec<JsNum> {
    let mut seen: HashSet<u64> = HashSet::new();
    let mut out = Vec::new();
    for n in a.iter().chain(b) {
        let v = if n.0 == 0.0 { 0.0 } else { n.0 };
        let bits = if v.is_nan() {
            f64::NAN.to_bits()
        } else {
            v.to_bits()
        };
        if seen.insert(bits) {
            out.push(JsNum(v));
        }
    }
    out
}

/// Merge PPrDirty (multiple operations accumulate on the element).
fn merge_p_pr_dirty(el: &mut SlideElement, d: &PPrDirty) {
    if d.has_no_key() {
        return;
    }
    with_element!(el, e => {
        let slot = &mut e.dirty_p_pr;
        // paraIndices: only stays restricted while every accumulated op was restricted
        let indices: Option<Vec<JsNum>> = match slot.as_ref() {
            None => (*d.para_indices).clone(),
            Some(existing) => match (existing.para_indices.as_deref(), d.para_indices.as_deref()) {
                (Some(a), Some(b)) => Some(union_indices(a, b)),
                _ => None,
            },
        };
        // { ...el.dirtyPPr, ...d }
        let mut merged: PPrDirty = (**slot).clone().unwrap_or_default();
        merged.assign(d);
        match indices {
            Some(indices) => merged.para_indices.set(indices),
            None => merged.para_indices.delete(),
        }
        slot.set(merged);
    });
}

/// The target paragraphs of a paragraph-format patch and their PPrDirty;
/// `None` when no paragraph is targeted.
fn format_paragraphs(
    paragraphs: &mut [Paragraph],
    patch: &ParagraphFormatPatch,
    para_indices: Option<&[f64]>,
) -> Option<PPrDirty> {
    let Some(indices) = para_indices else {
        return Some(apply_paragraph_format(paragraphs, patch));
    };
    let targets: Vec<usize> = indices
        .iter()
        .filter_map(|&i| paragraph_index(i, paragraphs.len()))
        .collect();
    if targets.is_empty() {
        return None;
    }
    let mut dirty = PPrDirty::default();
    for i in targets {
        if let Some(p) = paragraphs.get_mut(i) {
            apply_to_paragraph(p, patch, &mut dirty);
        }
    }
    Some(dirty)
}

/// Change paragraph formatting directly on a selected element (bullet/line
/// spacing/paragraph spacing/alignment), applied to all of its paragraphs
/// (text/shape/table; same as clicking bullets with a shape selected in PowerPoint).
/// paraIndices restricts the patch to those paragraphs (editing-mode selection).
pub fn set_element_paragraph_format(
    slide: &mut Slide,
    element_id: &str,
    patch: &ParagraphFormatPatch,
    para_indices: Option<&[f64]>,
) -> Result<bool, String> {
    let Some(index) = element_index(slide, element_id) else {
        return Ok(false);
    };
    let kind = match element_at(slide, index) {
        Some(SlideElement::Text(_)) => 1,
        Some(SlideElement::Table(_)) => 2,
        _ => 0,
    };
    match kind {
        1 => {
            let Some(el) = element_at(slide, index) else {
                return Ok(false);
            };
            let dirty = match el {
                SlideElement::Text(t) => paragraphs_of(t)
                    .filter(|p| !p.is_empty())
                    .and_then(|paragraphs| format_paragraphs(paragraphs, patch, para_indices)),
                _ => None,
            };
            let Some(mut dirty) = dirty else {
                return Ok(false);
            };
            if let Some(indices) = para_indices
                && !dirty.has_no_key()
            {
                dirty
                    .para_indices
                    .set(indices.iter().map(|&n| JsNum(n)).collect());
            }
            merge_p_pr_dirty(el, &dirty);
            Ok(with_element!(&*el, e => e.dirty_p_pr.is_some()))
        }
        2 => {
            let mut changed = false;
            for (r, len) in row_lengths(slide, index).into_iter().enumerate() {
                for c in 0..len {
                    let Some(paragraphs) = cell_paragraphs(slide, index, r, c) else {
                        continue;
                    };
                    apply_paragraph_format(paragraphs, patch);
                    let edited = paragraphs.clone();
                    if edit_table_cell_text(slide, element_id, r as f64, c as f64, &edited) {
                        changed = true;
                    }
                }
            }
            Ok(changed)
        }
        _ => Ok(false),
    }
}

/// Paragraph formatting for a group child (same semantics as setGroupChildFont; the pPr patch is
/// baked straight into the group bytes).
pub fn set_group_child_paragraph_format(
    slide: &mut Slide,
    group_id: &str,
    child_id: &str,
    patch: &ParagraphFormatPatch,
    para_indices: Option<&[f64]>,
) -> Result<bool, String> {
    // findGroupChild: the top-level group and its direct child
    let Some(elements) = slide.elements.as_mut() else {
        return Ok(false);
    };
    let Some(group_at) = elements
        .iter()
        .position(|e| e.id() == group_id && matches!(e, SlideElement::Group(_)))
    else {
        return Ok(false);
    };
    let Some(SlideElement::Group(grp)) = elements.get_mut(group_at) else {
        return Ok(false);
    };
    let Some(children) = grp.children.as_mut() else {
        return Ok(false);
    };
    let Some(child_at) = children.iter().position(|c| c.id() == child_id) else {
        return Ok(false);
    };
    let Some(SlideElement::Text(child)) = children.get_mut(child_at) else {
        return Ok(false);
    };
    let Some(paragraphs) = paragraphs_of(child).filter(|p| !p.is_empty()) else {
        return Ok(false);
    };
    let Some(mut dirty) = format_paragraphs(paragraphs, patch, para_indices) else {
        return Ok(false);
    };
    if dirty.has_no_key() {
        return Ok(false);
    }
    if let Some(indices) = para_indices {
        dirty
            .para_indices
            .set(indices.iter().map(|&n| JsNum(n)).collect());
    }
    let child_model: TextElement = (**child).clone();
    let patched =
        patch_group_child_xml(
            grp,
            child_model.nv_id.as_deref(),
            |xml| match patch_element_p_pr(&child_model, xml, &dirty)? {
                Some(patched) => Ok(patched),
                None => Ok(rebuild_tx_body(&child_model, xml)),
            },
        )?;
    if !patched {
        return Ok(false);
    }
    slide.structure_dirty.set(true);
    Ok(true)
}
