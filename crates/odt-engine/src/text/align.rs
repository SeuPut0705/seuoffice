//! `text/align.ts`: character alignment of an original paragraph text with its
//! edited text, used to move bookmarks and kept inline elements onto the edited
//! text and to find the original formatting of every edited character.
//!
//! The TypeScript compares `charCodeAt` values and counts `string.length`, so a
//! character outside the BMP is two positions that can be matched apart. This
//! port runs over the UTF-16 code units of both texts (`encode_utf16()`), and
//! every offset it takes or gives is a [`U16`].

use crate::offset::U16;

/// `LCS_CELLS`: largest middle region (original x edited characters) aligned by LCS.
const LCS_CELLS: i64 = 1_500_000;

/// `align`: per original character, the index of the matched edited character
/// (or -1).
fn align(a: &[u16], b: &[u16], early: bool) -> Vec<i32> {
    let mut matched = vec![-1i32; a.len()];
    let max = a.len().min(b.len());
    let mut p = 0usize;
    let mut s = 0usize;
    if early {
        while p < max && a[p] == b[p] {
            p += 1;
        }
        while s < max - p && a[a.len() - 1 - s] == b[b.len() - 1 - s] {
            s += 1;
        }
    } else {
        while s < max && a[a.len() - 1 - s] == b[b.len() - 1 - s] {
            s += 1;
        }
        while p < max - s && a[p] == b[p] {
            p += 1;
        }
    }
    for (i, slot) in matched.iter_mut().enumerate().take(p) {
        *slot = i as i32;
    }
    for k in 1..=s {
        matched[a.len() - k] = (b.len() - k) as i32;
    }
    let m = a.len() as i64 - p as i64 - s as i64;
    let n = b.len() as i64 - p as i64 - s as i64;
    if m <= 0 || n <= 0 || (m + 1) * (n + 1) > LCS_CELLS {
        return matched;
    }
    let (m, n) = (m as usize, n as usize);
    // early: lengths of LCS of suffixes, walk forward taking matches as soon as possible;
    // late: the same on the reversed middle
    let ca = |i: usize| if early { a[p + i] } else { a[p + m - 1 - i] };
    let cb = |j: usize| if early { b[p + j] } else { b[p + n - 1 - j] };
    let w = n + 1;
    let mut l = vec![0i32; (m + 1) * w];
    for i in (0..m).rev() {
        for j in (0..n).rev() {
            l[i * w + j] = if ca(i) == cb(j) {
                l[(i + 1) * w + j + 1] + 1
            } else {
                l[(i + 1) * w + j].max(l[i * w + j + 1])
            };
        }
    }
    let (mut i, mut j) = (0usize, 0usize);
    while i < m && j < n {
        if ca(i) == cb(j) && l[i * w + j] == l[(i + 1) * w + j + 1] + 1 {
            if early {
                matched[p + i] = (p + j) as i32;
            } else {
                matched[p + m - 1 - i] = (p + n - 1 - j) as i32;
            }
            i += 1;
            j += 1;
        } else if l[(i + 1) * w + j] >= l[i * w + j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    matched
}

/// The `bias` of `TextAlignment.map`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bias {
    Start,
    End,
}

/// `TextAlignment`
#[derive(Debug, Clone)]
pub struct TextAlignment {
    original_len: usize,
    edited_len: usize,
    early: Vec<i32>,
    late: Vec<i32>,
    edited_to_original: Vec<i32>,
}

/// `alignTexts`
pub fn align_texts(original: &str, edited: &str) -> TextAlignment {
    let a: Vec<u16> = original.encode_utf16().collect();
    let b: Vec<u16> = edited.encode_utf16().collect();
    let early = align(&a, &b, true);
    let late = align(&a, &b, false);
    let mut edited_to_original = vec![-1i32; b.len()];
    for (o, &e) in early.iter().enumerate() {
        if e >= 0 {
            edited_to_original[e as usize] = o as i32;
        }
    }
    TextAlignment {
        original_len: a.len(),
        edited_len: b.len(),
        early,
        late,
        edited_to_original,
    }
}

impl TextAlignment {
    /// `editedToOriginal[index]`; `None` where JavaScript reads `undefined`.
    fn e2o(&self, index: i64) -> Option<i32> {
        usize::try_from(index)
            .ok()
            .and_then(|i| self.edited_to_original.get(i).copied())
    }

    /// `TextAlignment.map`: an original offset (a position between characters)
    /// on the edited text. `Start`: right after the nearest kept character
    /// before it; `End`: right before the nearest kept character after it.
    pub fn map(&self, offset: U16, bias: Bias) -> U16 {
        let o = (offset.0 as usize).min(self.original_len);
        if bias == Bias::Start {
            for k in (0..o).rev() {
                if self.early[k] >= 0 {
                    return U16(self.early[k] as u32 + 1);
                }
            }
            return U16(0);
        }
        for k in o..self.original_len {
            if self.late[k] >= 0 {
                return U16(self.late[k] as u32);
            }
        }
        U16(self.edited_len as u32)
    }

    /// `TextAlignment.originalOf` for an edited position of the text: the
    /// original character an edited character continues, or the one replaced
    /// text lines up with; -1 when the original is empty.
    pub fn original_of(&self, index: U16) -> i64 {
        self.original_of_at(i64::from(index.0)) as i64
    }

    /// `TextAlignment.originalOf(index)` for any integer the caller hands the
    /// closure, including one outside the edited text (negative, past the end),
    /// where the lookups read `undefined`. The result is a JavaScript number:
    /// `NaN` where `Math.min(undefined, ...)` is.
    pub fn original_of_at(&self, index: i64) -> f64 {
        if self.original_len == 0 {
            return -1.0;
        }
        if let Some(v) = self.e2o(index) {
            if v >= 0 {
                return f64::from(v);
            }
        }
        // between the nearest kept characters: replaced text lines up position by position
        let mut ep = index - 1;
        while ep >= 0 && self.e2o(ep).is_some_and(|v| v < 0) {
            ep -= 1;
        }
        let mut en = index + 1;
        while en < self.edited_len as i64 && self.e2o(en).is_some_and(|v| v < 0) {
            en += 1;
        }
        let op = if ep >= 0 {
            self.e2o(ep).map_or(f64::NAN, f64::from)
        } else {
            -1.0
        };
        let on = if en < self.edited_len as i64 {
            self.e2o(en).map_or(f64::NAN, f64::from)
        } else {
            self.original_len as f64
        };
        let candidate = op + 1.0 + (index - ep - 1) as f64;
        if candidate < on {
            return candidate;
        }
        if op >= 0.0 {
            return op;
        }
        // Math.min(on, original.length - 1)
        let last = self.original_len as f64 - 1.0;
        if on.is_nan() { f64::NAN } else { on.min(last) }
    }

    /// `TextAlignment.intact`: whether original characters
    /// `[start, start+length)` survive unchanged and contiguous.
    pub fn intact(&self, start: U16, length: U16) -> bool {
        if length.0 == 0 {
            return false;
        }
        let first = self.early.get(start.0 as usize).copied();
        if first.is_some_and(|f| f < 0) {
            return false;
        }
        for k in 1..length.0 as usize {
            let at = self.early.get(start.0 as usize + k).copied();
            // `undefined !== first + k` is true; a number is compared by value
            match (at, first) {
                (Some(a), Some(f)) if a as i64 == f as i64 + k as i64 => {}
                _ => return false,
            }
        }
        true
    }
}
