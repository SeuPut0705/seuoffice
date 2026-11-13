/**
 * Character alignment of an original paragraph text with its edited text,
 * used to move bookmarks and kept inline elements onto the edited text and to
 * find the original formatting of every edited character.
 *
 * The common prefix and suffix are matched first; the region between them is
 * aligned by a longest-common-subsequence when it is small enough (several
 * separate edits in one paragraph), and left unmatched otherwise.
 *
 * Text inserted where it could slide over equal characters is ambiguous. Two
 * alignments resolve it toward "inside": starts use the one that matches
 * kept characters as early as possible (an insertion lands after a start),
 * ends the one that matches them as late as possible (it lands before an end).
 */

/** Largest middle region (original × edited characters) aligned by LCS. */
const LCS_CELLS = 1_500_000

/** Per original character, the index of the matched edited character (or -1). */
function align(a: string, b: string, early: boolean): Int32Array {
  const match = new Int32Array(a.length).fill(-1)
  const max = Math.min(a.length, b.length)
  let p = 0
  let s = 0
  if (early) {
    while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++
    while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++
  } else {
    while (s < max && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++
    while (p < max - s && a.charCodeAt(p) === b.charCodeAt(p)) p++
  }
  for (let i = 0; i < p; i++) match[i] = i
  for (let k = 1; k <= s; k++) match[a.length - k] = b.length - k
  const m = a.length - p - s
  const n = b.length - p - s
  if (m <= 0 || n <= 0 || (m + 1) * (n + 1) > LCS_CELLS) return match
  // early: lengths of LCS of suffixes, walk forward taking matches as soon as possible;
  // late: the same on the reversed middle
  const ca = (i: number) => (early ? a.charCodeAt(p + i) : a.charCodeAt(p + m - 1 - i))
  const cb = (j: number) => (early ? b.charCodeAt(p + j) : b.charCodeAt(p + n - 1 - j))
  const w = n + 1
  const L = new Int32Array((m + 1) * w)
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      L[i * w + j] =
        ca(i) === cb(j)
          ? L[(i + 1) * w + j + 1] + 1
          : Math.max(L[(i + 1) * w + j], L[i * w + j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (ca(i) === cb(j) && L[i * w + j] === L[(i + 1) * w + j + 1] + 1) {
      if (early) match[p + i] = p + j
      else match[p + m - 1 - i] = p + n - 1 - j
      i++
      j++
    } else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) i++
    else j++
  }
  return match
}

export interface TextAlignment {
  /**
   * An original offset (a position between characters) on the edited text.
   * `start`: right after the nearest kept character before it; `end`: right
   * before the nearest kept character after it.
   */
  map(offset: number, bias: 'start' | 'end'): number
  /** The original character an edited character continues, or the one replaced text lines up with; -1 when the original is empty. */
  originalOf(index: number): number
  /** Whether original characters `[start, start+length)` survive unchanged and contiguous. */
  intact(start: number, length: number): boolean
}

export function alignTexts(original: string, edited: string): TextAlignment {
  const early = align(original, edited, true)
  const late = align(original, edited, false)
  const editedToOriginal = new Int32Array(edited.length).fill(-1)
  early.forEach((e, o) => {
    if (e >= 0) editedToOriginal[e] = o
  })
  return {
    map(offset, bias) {
      const o = Math.max(0, Math.min(original.length, offset))
      if (bias === 'start') {
        for (let k = o - 1; k >= 0; k--) if (early[k] >= 0) return early[k] + 1
        return 0
      }
      for (let k = o; k < original.length; k++) if (late[k] >= 0) return late[k]
      return edited.length
    },
    originalOf(index) {
      if (!original.length) return -1
      if (editedToOriginal[index] >= 0) return editedToOriginal[index]
      // between the nearest kept characters: replaced text lines up position by position
      let ep = index - 1
      while (ep >= 0 && editedToOriginal[ep] < 0) ep--
      let en = index + 1
      while (en < edited.length && editedToOriginal[en] < 0) en++
      const op = ep >= 0 ? editedToOriginal[ep] : -1
      const on = en < edited.length ? editedToOriginal[en] : original.length
      const candidate = op + 1 + (index - ep - 1)
      if (candidate < on) return candidate
      if (op >= 0) return op
      return Math.min(on, original.length - 1)
    },
    intact(start, length) {
      if (length <= 0) return false
      const first = early[start]
      if (first < 0) return false
      for (let k = 1; k < length; k++) if (early[start + k] !== first + k) return false
      return true
    },
  }
}
