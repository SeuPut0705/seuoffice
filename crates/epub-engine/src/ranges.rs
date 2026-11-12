//! `ranges.ts` and `writing-mode.ts` of `packages/epub-engine`.
//!
//! A chapter text is UTF-16 code units, as the TypeScript string is: a range
//! may split a surrogate pair, and the text then holds a lone surrogate, which
//! a Rust `String` cannot. Offsets are `f64` because the TypeScript takes any
//! number: `composeReplacements` and `mapOffset` validate nothing, so NaN,
//! fractions and negatives reach their arithmetic.

use jscompat::{number_to_string, to_number};
use serde_json::{Map, Value};

/// `RangeReplacement`: `[start, end)` of the chapter text becomes `text`.
#[derive(Debug, Clone, PartialEq)]
pub struct RangeReplacement {
    pub start: f64,
    pub end: f64,
    pub text: Vec<u16>,
}

/// What `applyReplacements` throws: a `RangeError` with this message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RangeError(pub String);

/// `sortReplacements`: by position; insertions at the same offset keep their given order.
pub fn sort_replacements(replacements: &[RangeReplacement]) -> Vec<&RangeReplacement> {
    sort_order(replacements)
        .into_iter()
        .map(|index| &replacements[index])
        .collect()
}

/// The positions in `replacements` of what `sortReplacements` returns, in its order.
fn sort_order(replacements: &[RangeReplacement]) -> Vec<usize> {
    array_sort(replacements.len(), |a, b| {
        let (x, y) = (&replacements[a], &replacements[b]);
        or(x.start - y.start, || {
            or(x.end - y.end, || a as f64 - b as f64)
        })
    })
}

/// `x || y` on numbers: 0, -0 and NaN are false.
fn or(x: f64, y: impl FnOnce() -> f64) -> f64 {
    if x == 0.0 || x.is_nan() { y() } else { x }
}

/// `validateReplacements`: the first problem, or `None` where the list applies
/// to a text of `length` code units.
pub fn validate_replacements(replacements: &[RangeReplacement], length: f64) -> Option<String> {
    problem_of(&sort_replacements(replacements), length)
}

fn problem_of(sorted: &[&RangeReplacement], length: f64) -> Option<String> {
    let mut cursor = 0.0;
    for r in sorted {
        if !is_integer(r.start) || !is_integer(r.end) {
            return Some("non-integer offset".to_owned());
        }
        if r.start < 0.0 || r.end < r.start || r.end > length {
            return Some(format!(
                "range [{}, {}) is out of bounds",
                number_to_string(r.start),
                number_to_string(r.end)
            ));
        }
        if r.start < cursor {
            return Some(format!(
                "range [{}, {}) overlaps another",
                number_to_string(r.start),
                number_to_string(r.end)
            ));
        }
        cursor = r.end;
    }
    None
}

/// `applyReplacements`. The TypeScript sorts twice, in the validation and
/// here; the comparator is pure, so one sort gives both.
pub fn apply_replacements(
    source: &[u16],
    replacements: &[RangeReplacement],
) -> Result<Vec<u16>, RangeError> {
    let sorted = sort_replacements(replacements);
    if let Some(problem) = problem_of(&sorted, source.len() as f64) {
        return Err(RangeError(problem));
    }
    let mut out = Vec::with_capacity(source.len());
    let mut cursor = 0;
    for r in sorted {
        // validated: integers within the source, in order, not overlapping
        out.extend_from_slice(&source[cursor..r.start as usize]);
        out.extend_from_slice(&r.text);
        cursor = r.end as usize;
    }
    out.extend_from_slice(&source[cursor..]);
    Ok(out)
}

/// `mapOffset`: where `offset` lands after the replacements, taken in the
/// order given, or `None` where a non-empty replaced range covers it.
pub fn map_offset(offset: f64, replacements: &[RangeReplacement]) -> Option<f64> {
    let mut delta = 0.0;
    for r in replacements {
        if r.start <= offset && offset < r.end {
            return None;
        }
        if r.end <= offset {
            delta += r.text.len() as f64 - (r.end - r.start);
        }
    }
    Some(offset + delta)
}

#[derive(Debug, Clone, Copy)]
enum Piece<'t> {
    Copy { start: f64, end: f64 },
    Text(&'t [u16]),
}

impl Piece<'_> {
    fn length(&self) -> f64 {
        match *self {
            Piece::Copy { start, end } => end - start,
            Piece::Text(text) => text.len() as f64,
        }
    }
}

fn slice_pieces<'t>(pieces: &[Piece<'t>], from: f64, to: f64, out: &mut Vec<Piece<'t>>) {
    let mut pos = 0.0;
    for p in pieces {
        let length = p.length();
        let a = math_max(from, pos);
        let b = math_min(to, pos + length);
        if a < b {
            out.push(match *p {
                Piece::Copy { start, .. } => Piece::Copy {
                    start: start + (a - pos),
                    end: start + (b - pos),
                },
                Piece::Text(text) => Piece::Text(slice(text, a - pos, b - pos)),
            });
        }
        pos += length;
    }
}

fn apply_to_pieces<'t>(
    pieces: &[Piece<'t>],
    replacements: &'t [RangeReplacement],
) -> Vec<Piece<'t>> {
    let total = pieces.iter().fold(0.0, |n, p| n + p.length());
    let mut out = Vec::new();
    let mut cursor = 0.0;
    for r in sort_replacements(replacements) {
        slice_pieces(pieces, cursor, r.start, &mut out);
        if !r.text.is_empty() {
            out.push(Piece::Text(&r.text));
        }
        cursor = r.end;
    }
    slice_pieces(pieces, cursor, total, &mut out);
    out
}

/// `trim`: the replacement of `[start, end)` of `base` by `text`, shrunk by
/// the prefix and suffix it shares with what it replaces.
fn trim(base: &[u16], start: f64, end: f64, text: &[u16]) -> Option<RangeReplacement> {
    let old = slice(base, start, end);
    if old == text {
        return None;
    }
    let max = old.len().min(text.len());
    let mut head = 0;
    while head < max && old[head] == text[head] {
        head += 1;
    }
    let mut tail = 0;
    while tail < max - head && old[old.len() - 1 - tail] == text[text.len() - 1 - tail] {
        tail += 1;
    }
    Some(RangeReplacement {
        start: start + head as f64,
        end: end - tail as f64,
        text: text[head..text.len() - tail].to_vec(),
    })
}

/// `composeReplacements`: `first` applies to `base`, `second` to the result of
/// `first`; one list against `base`, every replacement trimmed to what changes.
pub fn compose_replacements(
    base: &[u16],
    first: &[RangeReplacement],
    second: &[RangeReplacement],
) -> Vec<RangeReplacement> {
    let initial = [Piece::Copy {
        start: 0.0,
        end: base.len() as f64,
    }];
    let pieces = apply_to_pieces(&apply_to_pieces(&initial, first), second);
    let mut out = Vec::new();
    let mut cursor = 0.0;
    let mut pending = Vec::new();
    for p in pieces {
        match p {
            Piece::Text(text) => pending.extend_from_slice(text),
            Piece::Copy { start, end } => {
                if start != cursor || !pending.is_empty() {
                    flush(base, cursor, start, &mut pending, &mut out);
                }
                cursor = end;
            }
        }
    }
    flush(base, cursor, base.len() as f64, &mut pending, &mut out);
    out
}

fn flush(
    base: &[u16],
    cursor: f64,
    up_to: f64,
    pending: &mut Vec<u16>,
    out: &mut Vec<RangeReplacement>,
) {
    if up_to > cursor || !pending.is_empty() {
        out.extend(trim(base, cursor, up_to, pending));
    }
    pending.clear();
}

/// `Number.isInteger`
fn is_integer(x: f64) -> bool {
    x.is_finite() && x.trunc() == x
}

/// `Math.max` of two: NaN wins, +0 is above -0.
fn math_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_positive() { a } else { b }
    } else if a > b {
        a
    } else {
        b
    }
}

/// `Math.min` of two: NaN wins, -0 is below +0.
fn math_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_negative() { a } else { b }
    } else if a < b {
        a
    } else {
        b
    }
}

/// `String.prototype.slice(start, end)`: each bound truncated toward zero,
/// NaN read as 0, a negative one counted from the end.
fn slice(units: &[u16], start: f64, end: f64) -> &[u16] {
    let length = units.len() as f64;
    let bound = |relative: f64| {
        let relative = if relative.is_nan() {
            0.0
        } else {
            relative.trunc()
        };
        (if relative < 0.0 {
            (length + relative).max(0.0)
        } else {
            relative.min(length)
        }) as usize
    };
    let (from, to) = (bound(start), bound(end));
    if from < to { &units[from..to] } else { &[] }
}

/// `kMinGallopWins`
const MIN_GALLOP: isize = 7;

/// `Array.prototype.sort(compare)` over `0..length` as V8 13.6 (Node 24) runs
/// it: TimSort, comparison for comparison, from
/// `third_party/v8/builtins/array-sort.tq`. Every stable sort agrees with it
/// under a consistent comparator. The one of `sortReplacements` stops being
/// consistent once an offset is NaN, and then only the same comparisons in
/// the same order give the order Node gives.
fn array_sort(length: usize, compare: impl FnMut(usize, usize) -> f64) -> Vec<usize> {
    let mut sort = TimSort {
        work: (0..length).collect(),
        temp: Vec::new(),
        runs: Vec::new(),
        min_gallop: MIN_GALLOP,
        compare,
    };
    sort.sort();
    sort.work
}

struct TimSort<F> {
    work: Vec<usize>,
    temp: Vec<usize>,
    /// Pending runs, `(base, length)`.
    runs: Vec<(usize, usize)>,
    min_gallop: isize,
    compare: F,
}

/// Where the two runs of a merge stopped: the rest of the temporary copy goes
/// in (`Succeed`), or one element of it goes to the far end of the other
/// run (`CopyB` of `MergeLow`, `CopyA` of `MergeHigh`).
enum MergeEnd {
    Succeed,
    CopyRest,
}

/// `SortCompareUserFn`: a NaN answer counts as 0.
fn order<F: FnMut(usize, usize) -> f64>(compare: &mut F, x: usize, y: usize) -> f64 {
    let v = compare(x, y);
    if v.is_nan() { 0.0 } else { v }
}

/// An index of the merges, which count in `isize` as V8 does in Smi: a cursor
/// passes below its run once the run is used up.
fn at(index: isize) -> usize {
    index as usize
}

/// `ComputeMinRunLength`
fn min_run_length(mut n: usize) -> usize {
    let mut r = 0;
    while n >= 64 {
        r |= n & 1;
        n >>= 1;
    }
    n + r
}

/// `GallopLeft`
fn gallop_left<F: FnMut(usize, usize) -> f64>(
    compare: &mut F,
    array: &[usize],
    key: usize,
    base: usize,
    length: usize,
    hint: usize,
) -> usize {
    let (base, length, hint) = (base as isize, length as isize, hint as isize);
    let mut last_ofs: isize = 0;
    let mut offset: isize = 1;
    if order(compare, array[at(base + hint)], key) < 0.0 {
        let max_ofs = length - hint;
        while offset < max_ofs {
            if order(compare, array[at(base + hint + offset)], key) >= 0.0 {
                break;
            }
            last_ofs = offset;
            offset = (offset << 1) + 1;
        }
        if offset > max_ofs {
            offset = max_ofs;
        }
        last_ofs += hint;
        offset += hint;
    } else {
        let max_ofs = hint + 1;
        while offset < max_ofs {
            if order(compare, array[at(base + hint - offset)], key) < 0.0 {
                break;
            }
            last_ofs = offset;
            offset = (offset << 1) + 1;
        }
        if offset > max_ofs {
            offset = max_ofs;
        }
        (last_ofs, offset) = (hint - offset, hint - last_ofs);
    }
    last_ofs += 1;
    while last_ofs < offset {
        let m = last_ofs + ((offset - last_ofs) >> 1);
        if order(compare, array[at(base + m)], key) < 0.0 {
            last_ofs = m + 1;
        } else {
            offset = m;
        }
    }
    at(offset)
}

/// `GallopRight`
fn gallop_right<F: FnMut(usize, usize) -> f64>(
    compare: &mut F,
    array: &[usize],
    key: usize,
    base: usize,
    length: usize,
    hint: usize,
) -> usize {
    let (base, length, hint) = (base as isize, length as isize, hint as isize);
    let mut last_ofs: isize = 0;
    let mut offset: isize = 1;
    if order(compare, key, array[at(base + hint)]) < 0.0 {
        let max_ofs = hint + 1;
        while offset < max_ofs {
            if order(compare, key, array[at(base + hint - offset)]) >= 0.0 {
                break;
            }
            last_ofs = offset;
            offset = (offset << 1) + 1;
        }
        if offset > max_ofs {
            offset = max_ofs;
        }
        (last_ofs, offset) = (hint - offset, hint - last_ofs);
    } else {
        let max_ofs = length - hint;
        while offset < max_ofs {
            if order(compare, key, array[at(base + hint + offset)]) < 0.0 {
                break;
            }
            last_ofs = offset;
            offset = (offset << 1) + 1;
        }
        if offset > max_ofs {
            offset = max_ofs;
        }
        last_ofs += hint;
        offset += hint;
    }
    last_ofs += 1;
    while last_ofs < offset {
        let m = last_ofs + ((offset - last_ofs) >> 1);
        if order(compare, key, array[at(base + m)]) < 0.0 {
            offset = m;
        } else {
            last_ofs = m + 1;
        }
    }
    at(offset)
}

impl<F: FnMut(usize, usize) -> f64> TimSort<F> {
    /// `ArrayTimSortImpl`
    fn sort(&mut self) {
        let length = self.work.len();
        if length < 2 {
            return;
        }
        let mut remaining = length;
        let mut low = 0;
        let min_run = min_run_length(remaining);
        while remaining != 0 {
            let mut run = self.count_and_make_run(low, low + remaining);
            if run < min_run {
                let forced = min_run.min(remaining);
                self.binary_insertion_sort(low, low + run, low + forced);
                run = forced;
            }
            self.runs.push((low, run));
            self.merge_collapse();
            low += run;
            remaining -= run;
        }
        self.merge_force_collapse();
    }

    /// `BinaryInsertionSort`
    fn binary_insertion_sort(&mut self, low: usize, start: usize, high: usize) {
        let mut start = if low == start { start + 1 } else { start };
        while start < high {
            let pivot = self.work[start];
            let (mut left, mut right) = (low, start);
            while left < right {
                let mid = left + ((right - left) >> 1);
                if order(&mut self.compare, pivot, self.work[mid]) < 0.0 {
                    right = mid;
                } else {
                    left = mid + 1;
                }
            }
            self.work.copy_within(left..start, left + 1);
            self.work[left] = pivot;
            start += 1;
        }
    }

    /// `CountAndMakeRun`: a strictly descending run is reversed.
    fn count_and_make_run(&mut self, low_arg: usize, high: usize) -> usize {
        let low = low_arg + 1;
        if low == high {
            return 1;
        }
        let mut run = 2;
        let mut previous = self.work[low];
        let descending = order(&mut self.compare, previous, self.work[low - 1]) < 0.0;
        for index in low + 1..high {
            let current = self.work[index];
            let o = order(&mut self.compare, current, previous);
            if descending {
                if o >= 0.0 {
                    break;
                }
            } else if o < 0.0 {
                break;
            }
            previous = current;
            run += 1;
        }
        if descending {
            self.work[low_arg..low_arg + run].reverse();
        }
        run
    }

    /// `RunInvariantEstablished`
    fn invariant(&self, n: usize) -> bool {
        n < 2 || self.runs[n - 2].1 > self.runs[n - 1].1 + self.runs[n].1
    }

    /// `MergeCollapse`
    fn merge_collapse(&mut self) {
        while self.runs.len() > 1 {
            let mut n = self.runs.len() - 2;
            if !self.invariant(n + 1) || !self.invariant(n) {
                if self.runs[n - 1].1 < self.runs[n + 1].1 {
                    n -= 1;
                }
                self.merge_at(n);
            } else if self.runs[n].1 <= self.runs[n + 1].1 {
                self.merge_at(n);
            } else {
                break;
            }
        }
    }

    /// `MergeForceCollapse`
    fn merge_force_collapse(&mut self) {
        while self.runs.len() > 1 {
            let mut n = self.runs.len() - 2;
            if n > 0 && self.runs[n - 1].1 < self.runs[n + 1].1 {
                n -= 1;
            }
            self.merge_at(n);
        }
    }

    /// `MergeAt`: merges the runs `i` and `i + 1` of the stack.
    fn merge_at(&mut self, i: usize) {
        let (mut base_a, mut length_a) = self.runs[i];
        let (base_b, length_b) = self.runs[i + 1];
        self.runs[i].1 = length_a + length_b;
        self.runs.remove(i + 1);

        let k = gallop_right(
            &mut self.compare,
            &self.work,
            self.work[base_b],
            base_a,
            length_a,
            0,
        );
        base_a += k;
        length_a -= k;
        if length_a == 0 {
            return;
        }
        let key_left = self.work[base_a + length_a - 1];
        let length_b = gallop_left(
            &mut self.compare,
            &self.work,
            key_left,
            base_b,
            length_b,
            length_b - 1,
        );
        if length_b == 0 {
            return;
        }
        if length_a <= length_b {
            self.merge_low(base_a, length_a, base_b, length_b);
        } else {
            self.merge_high(base_a, length_a, base_b, length_b);
        }
    }

    /// `MergeLow`
    fn merge_low(&mut self, base_a: usize, length_a: usize, base_b: usize, length_b: usize) {
        self.temp.clear();
        self.temp
            .extend_from_slice(&self.work[base_a..base_a + length_a]);
        let (mut length_a, mut length_b) = (length_a as isize, length_b as isize);
        let mut dest = base_a as isize;
        let mut cursor_temp: isize = 0;
        let mut cursor_b = base_b as isize;

        self.work[at(dest)] = self.work[at(cursor_b)];
        dest += 1;
        cursor_b += 1;

        let end = 'merge: {
            length_b -= 1;
            if length_b == 0 {
                break 'merge MergeEnd::Succeed;
            }
            if length_a == 1 {
                break 'merge MergeEnd::CopyRest;
            }
            let mut min_gallop = self.min_gallop;
            loop {
                let mut wins_a: isize = 0;
                let mut wins_b: isize = 0;
                loop {
                    if order(
                        &mut self.compare,
                        self.work[at(cursor_b)],
                        self.temp[at(cursor_temp)],
                    ) < 0.0
                    {
                        self.work[at(dest)] = self.work[at(cursor_b)];
                        dest += 1;
                        cursor_b += 1;
                        wins_b += 1;
                        length_b -= 1;
                        wins_a = 0;
                        if length_b == 0 {
                            break 'merge MergeEnd::Succeed;
                        }
                        if wins_b >= min_gallop {
                            break;
                        }
                    } else {
                        self.work[at(dest)] = self.temp[at(cursor_temp)];
                        dest += 1;
                        cursor_temp += 1;
                        wins_a += 1;
                        length_a -= 1;
                        wins_b = 0;
                        if length_a == 1 {
                            break 'merge MergeEnd::CopyRest;
                        }
                        if wins_a >= min_gallop {
                            break;
                        }
                    }
                }

                min_gallop += 1;
                let mut first_iteration = true;
                while wins_a >= MIN_GALLOP || wins_b >= MIN_GALLOP || first_iteration {
                    first_iteration = false;
                    min_gallop = (min_gallop - 1).max(1);
                    self.min_gallop = min_gallop;

                    let key = self.work[at(cursor_b)];
                    wins_a = gallop_right(
                        &mut self.compare,
                        &self.temp,
                        key,
                        at(cursor_temp),
                        at(length_a),
                        0,
                    ) as isize;
                    if wins_a > 0 {
                        self.work[at(dest)..at(dest + wins_a)]
                            .copy_from_slice(&self.temp[at(cursor_temp)..at(cursor_temp + wins_a)]);
                        dest += wins_a;
                        cursor_temp += wins_a;
                        length_a -= wins_a;
                        if length_a == 1 {
                            break 'merge MergeEnd::CopyRest;
                        }
                        // impossible under a consistent comparator
                        if length_a == 0 {
                            break 'merge MergeEnd::Succeed;
                        }
                    }
                    self.work[at(dest)] = self.work[at(cursor_b)];
                    dest += 1;
                    cursor_b += 1;
                    length_b -= 1;
                    if length_b == 0 {
                        break 'merge MergeEnd::Succeed;
                    }

                    let key = self.temp[at(cursor_temp)];
                    wins_b = gallop_left(
                        &mut self.compare,
                        &self.work,
                        key,
                        at(cursor_b),
                        at(length_b),
                        0,
                    ) as isize;
                    if wins_b > 0 {
                        self.work
                            .copy_within(at(cursor_b)..at(cursor_b + wins_b), at(dest));
                        dest += wins_b;
                        cursor_b += wins_b;
                        length_b -= wins_b;
                        if length_b == 0 {
                            break 'merge MergeEnd::Succeed;
                        }
                    }
                    self.work[at(dest)] = self.temp[at(cursor_temp)];
                    dest += 1;
                    cursor_temp += 1;
                    length_a -= 1;
                    if length_a == 1 {
                        break 'merge MergeEnd::CopyRest;
                    }
                }
                min_gallop += 1;
                self.min_gallop = min_gallop;
            }
        };
        match end {
            MergeEnd::Succeed => {
                if length_a > 0 {
                    self.work[at(dest)..at(dest + length_a)]
                        .copy_from_slice(&self.temp[at(cursor_temp)..at(cursor_temp + length_a)]);
                }
            }
            MergeEnd::CopyRest => {
                self.work
                    .copy_within(at(cursor_b)..at(cursor_b + length_b), at(dest));
                self.work[at(dest + length_b)] = self.temp[at(cursor_temp)];
            }
        }
    }

    /// `MergeHigh`
    fn merge_high(&mut self, base_a: usize, length_a: usize, base_b: usize, length_b: usize) {
        self.temp.clear();
        self.temp
            .extend_from_slice(&self.work[base_b..base_b + length_b]);
        let base_a = base_a as isize;
        let (mut length_a, mut length_b) = (length_a as isize, length_b as isize);
        let mut dest = base_b as isize + length_b - 1;
        let mut cursor_temp = length_b - 1;
        let mut cursor_a = base_a + length_a - 1;

        self.work[at(dest)] = self.work[at(cursor_a)];
        dest -= 1;
        cursor_a -= 1;

        let end = 'merge: {
            length_a -= 1;
            if length_a == 0 {
                break 'merge MergeEnd::Succeed;
            }
            if length_b == 1 {
                break 'merge MergeEnd::CopyRest;
            }
            let mut min_gallop = self.min_gallop;
            loop {
                let mut wins_a: isize = 0;
                let mut wins_b: isize = 0;
                loop {
                    if order(
                        &mut self.compare,
                        self.temp[at(cursor_temp)],
                        self.work[at(cursor_a)],
                    ) < 0.0
                    {
                        self.work[at(dest)] = self.work[at(cursor_a)];
                        dest -= 1;
                        cursor_a -= 1;
                        wins_a += 1;
                        length_a -= 1;
                        wins_b = 0;
                        if length_a == 0 {
                            break 'merge MergeEnd::Succeed;
                        }
                        if wins_a >= min_gallop {
                            break;
                        }
                    } else {
                        self.work[at(dest)] = self.temp[at(cursor_temp)];
                        dest -= 1;
                        cursor_temp -= 1;
                        wins_b += 1;
                        length_b -= 1;
                        wins_a = 0;
                        if length_b == 1 {
                            break 'merge MergeEnd::CopyRest;
                        }
                        if wins_b >= min_gallop {
                            break;
                        }
                    }
                }

                min_gallop += 1;
                let mut first_iteration = true;
                while wins_a >= MIN_GALLOP || wins_b >= MIN_GALLOP || first_iteration {
                    first_iteration = false;
                    min_gallop = (min_gallop - 1).max(1);
                    self.min_gallop = min_gallop;

                    let key = self.temp[at(cursor_temp)];
                    let k = gallop_right(
                        &mut self.compare,
                        &self.work,
                        key,
                        at(base_a),
                        at(length_a),
                        at(length_a - 1),
                    );
                    wins_a = length_a - k as isize;
                    if wins_a > 0 {
                        dest -= wins_a;
                        cursor_a -= wins_a;
                        self.work
                            .copy_within(at(cursor_a + 1)..at(cursor_a + 1 + wins_a), at(dest + 1));
                        length_a -= wins_a;
                        if length_a == 0 {
                            break 'merge MergeEnd::Succeed;
                        }
                    }
                    self.work[at(dest)] = self.temp[at(cursor_temp)];
                    dest -= 1;
                    cursor_temp -= 1;
                    length_b -= 1;
                    if length_b == 1 {
                        break 'merge MergeEnd::CopyRest;
                    }

                    let key = self.work[at(cursor_a)];
                    let k = gallop_left(
                        &mut self.compare,
                        &self.temp,
                        key,
                        0,
                        at(length_b),
                        at(length_b - 1),
                    );
                    wins_b = length_b - k as isize;
                    if wins_b > 0 {
                        dest -= wins_b;
                        cursor_temp -= wins_b;
                        self.work[at(dest + 1)..at(dest + 1 + wins_b)].copy_from_slice(
                            &self.temp[at(cursor_temp + 1)..at(cursor_temp + 1 + wins_b)],
                        );
                        length_b -= wins_b;
                        if length_b == 1 {
                            break 'merge MergeEnd::CopyRest;
                        }
                        // impossible under a consistent comparator
                        if length_b == 0 {
                            break 'merge MergeEnd::Succeed;
                        }
                    }
                    self.work[at(dest)] = self.work[at(cursor_a)];
                    dest -= 1;
                    cursor_a -= 1;
                    length_a -= 1;
                    if length_a == 0 {
                        break 'merge MergeEnd::Succeed;
                    }
                }
                min_gallop += 1;
                self.min_gallop = min_gallop;
            }
        };
        match end {
            MergeEnd::Succeed => {
                if length_b > 0 {
                    let to = dest - (length_b - 1);
                    self.work[at(to)..at(to + length_b)]
                        .copy_from_slice(&self.temp[..at(length_b)]);
                }
            }
            MergeEnd::CopyRest => {
                dest -= length_a;
                cursor_a -= length_a;
                self.work
                    .copy_within(at(cursor_a + 1)..at(cursor_a + 1 + length_a), at(dest + 1));
                self.work[at(dest)] = self.temp[at(cursor_temp)];
            }
        }
    }
}

/// `writing-mode.ts`, over `&str`. Neither pattern counts characters or names
/// a surrogate: a character outside the BMP matches here as its two code
/// units match in JavaScript, and a lone surrogate is an ordinary character
/// there as U+FFFD is here, so a caller holding UTF-16 converts with
/// `String::from_utf16_lossy`. A stylesheet comes out of `TextDecoder`,
/// which leaves no lone surrogate.
pub mod writing_mode {
    use jscompat::{js_regex, trim};

    /// `isVerticalWritingMode`: `None` stands for anything not a string.
    pub fn is_vertical_writing_mode(value: Option<&str>) -> bool {
        value.is_some_and(|value| js_regex!(r"^vertical-", "i").test(trim(value)))
    }

    /// `stripCommentsAndStrings`: a linear scan with the semantics of
    /// `/\*[\s\S]*?(?:\*\/|$)|"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'`
    /// replaced by one space. A comment runs to `*/` or the end; a string needs
    /// its closing quote before a bare newline or the end, else its opening
    /// quote stays. Only ASCII bytes are tested, so UTF-8 sequences pass whole.
    fn strip_comments_and_strings(css: &str) -> String {
        let b = css.as_bytes();
        let mut out = String::with_capacity(css.len());
        let (mut i, mut copied) = (0, 0);
        let mut dead: [Option<Vec<bool>>; 2] = [None, None];
        while i < b.len() {
            let end = match b[i] {
                b'/' if b.get(i + 1) == Some(&b'*') => {
                    let mut j = i + 2;
                    loop {
                        if j >= b.len() {
                            break Some(b.len());
                        }
                        if b[j] == b'*' && b.get(j + 1) == Some(&b'/') {
                            break Some(j + 2);
                        }
                        j += 1;
                    }
                }
                q @ (b'"' | b'\'') => {
                    // a string that does not close fails at the same place from
                    // every token boundary it crossed: those boundaries are
                    // marked, so a later quote on one fails at once
                    let dead = &mut dead[usize::from(q == b'\'')];
                    let mut j = i + 1;
                    let mut crossed = Vec::new();
                    let end = loop {
                        if dead.as_ref().is_some_and(|d: &Vec<bool>| d[j]) {
                            break None;
                        }
                        crossed.push(j);
                        match b.get(j) {
                            None | Some(b'\n') => break None,
                            Some(&c) if c == q => break Some(j + 1),
                            Some(b'\\') => {
                                if j + 1 >= b.len() {
                                    break None;
                                }
                                j += 2;
                                // skip a whole UTF-8 sequence's continuation bytes
                                while j < b.len() && b[j] & 0xC0 == 0x80 {
                                    j += 1;
                                }
                            }
                            Some(_) => j += 1,
                        }
                    };
                    if end.is_none() {
                        let d = dead.get_or_insert_with(|| vec![false; b.len() + 1]);
                        for at in crossed {
                            d[at] = true;
                        }
                    }
                    end
                }
                _ => None,
            };
            match end {
                Some(e) => {
                    out.push_str(&css[copied..i]);
                    out.push(' ');
                    i = e;
                    copied = e;
                }
                None => i += 1,
            }
        }
        out.push_str(&css[copied..]);
        out
    }

    /// `cssDeclaresVerticalWriting`
    pub fn css_declares_vertical_writing(css: &str) -> bool {
        js_regex!(
            r"(?:^|[\s;{])(?:-epub-|-webkit-)?writing-mode\s*:\s*vertical-",
            "i"
        )
        .test(&strip_comments_and_strings(css))
    }
}

/// The gate's entry: `function` is the TypeScript export. Texts of the
/// ranges functions cross as arrays of UTF-16 code units both ways; an offset
/// is a JSON number or the text `Number()` reads back (`"NaN"`, `"-0"`,
/// `"Infinity"`); a number JSON cannot hold leaves as `{ "$number": String(n) }`.
/// `sortReplacements` answers with the input positions of what it returns.
pub fn call(
    function: &str,
    text: &str,
    _bytes: &[u8],
    args: &Value,
) -> Result<Value, (String, String)> {
    Ok(match function {
        "sortReplacements" => Value::Array(
            sort_order(&replacements_arg(args, "replacements")?)
                .into_iter()
                .map(Value::from)
                .collect(),
        ),
        "validateReplacements" => validate_replacements(
            &replacements_arg(args, "replacements")?,
            number_arg(args, "length")?,
        )
        .map_or(Value::Null, Value::String),
        "applyReplacements" => {
            match apply_replacements(
                &units_arg(args, "source")?,
                &replacements_arg(args, "replacements")?,
            ) {
                Ok(units) => units_value(&units),
                Err(RangeError(message)) => return Err(("RangeError".to_owned(), message)),
            }
        }
        "mapOffset" => map_offset(
            number_arg(args, "offset")?,
            &replacements_arg(args, "replacements")?,
        )
        .map_or(Value::Null, number_value),
        "composeReplacements" => Value::Array(
            compose_replacements(
                &units_arg(args, "base")?,
                &replacements_arg(args, "first")?,
                &replacements_arg(args, "second")?,
            )
            .iter()
            .map(replacement_value)
            .collect(),
        ),
        "isVerticalWritingMode" => Value::Bool(writing_mode::is_vertical_writing_mode(
            args.get("value").and_then(Value::as_str),
        )),
        "cssDeclaresVerticalWriting" => Value::Bool(writing_mode::css_declares_vertical_writing(text)),
        // the dispatcher asks the next module on exactly this answer
        _ => return Err(wire_error(format!("unknown function {function}"))),
    })
}

fn wire_error(message: String) -> (String, String) {
    ("Error".to_owned(), message)
}

fn number_of(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => Some(to_number(text)),
        _ => None,
    }
}

fn units_of(value: Option<&Value>) -> Option<Vec<u16>> {
    value?
        .as_array()?
        .iter()
        .map(|unit| u16::try_from(unit.as_u64()?).ok())
        .collect()
}

fn number_arg(args: &Value, key: &str) -> Result<f64, (String, String)> {
    number_of(args.get(key)).ok_or_else(|| wire_error(format!("args.{key} is not a number")))
}

fn units_arg(args: &Value, key: &str) -> Result<Vec<u16>, (String, String)> {
    units_of(args.get(key))
        .ok_or_else(|| wire_error(format!("args.{key} is not a list of code units")))
}

fn replacements_arg(args: &Value, key: &str) -> Result<Vec<RangeReplacement>, (String, String)> {
    args.get(key)
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .map(|item| {
                    Some(RangeReplacement {
                        start: number_of(item.get("start"))?,
                        end: number_of(item.get("end"))?,
                        text: units_of(item.get("text"))?,
                    })
                })
                .collect()
        })
        .ok_or_else(|| wire_error(format!("args.{key} is not a list of replacements")))
}

/// A number as `JSON.stringify` writes it (-0 is 0), or `{ "$number" }`.
fn number_value(x: f64) -> Value {
    if !x.is_finite() {
        let mut object = Map::new();
        object.insert("$number".to_owned(), Value::String(number_to_string(x)));
        Value::Object(object)
    } else if x == 0.0 {
        Value::from(0)
    } else if x.fract() == 0.0 && x.abs() <= 9_007_199_254_740_991.0 {
        Value::from(x as i64)
    } else {
        Value::from(x)
    }
}

fn units_value(units: &[u16]) -> Value {
    Value::Array(units.iter().map(|&unit| Value::from(unit)).collect())
}

fn replacement_value(r: &RangeReplacement) -> Value {
    let mut object = Map::new();
    object.insert("start".to_owned(), number_value(r.start));
    object.insert("end".to_owned(), number_value(r.end));
    object.insert("text".to_owned(), units_value(&r.text));
    Value::Object(object)
}
