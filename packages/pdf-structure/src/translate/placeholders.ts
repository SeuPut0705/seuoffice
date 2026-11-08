/**
 * Placeholders (spec §8): what the model must not translate or lose leaves the
 * block as a short tag, and the returned text is checked tag by tag.
 *
 *   bold / italic boundaries   <b>…</b>  <i>…</i>
 *   link (target kept here)    <a1>…</a1>, <a2>…</a2>, …
 *   footnote marker            <n1/>, <n2/>, …
 *   inline formula             <m1/>, <m2/>, …
 *   line break                 <br/>
 *
 * The text between tags is translated, and the model may move the tags with
 * the words they wrap. A translation is accepted only when it has exactly the
 * same tags, each as many times, and every pair opens before it closes.
 * Literal `&`, `<`, `>` in the source are sent as `&amp;`, `&lt;`, `&gt;` so
 * they can never read as tags; entities are decoded on the way back, and a
 * raw `&` or `<` the model writes stays text.
 */
import type { FootnoteRefRun, InlineRun, MathRun, TextRun } from '../tree/types'

/** a block ready to send, with what its placeholders stand for */
export interface EncodedBlock {
  /** the block text with placeholders */
  text: string
  /** link targets; `<aK>` is links[K-1] */
  links: string[]
  /** footnote markers; `<nK/>` is notes[K-1] */
  notes: FootnoteRefRun[]
  /** inline formulas; `<mK/>` is maths[K-1] */
  maths: MathRun[]
}

export type PlaceholderFailure = 'placeholder-mismatch' | 'empty-translation'

export type DecodedTranslation =
  { ok: true; runs: InlineRun[] } | { ok: false; reason: PlaceholderFailure }

const escapeText = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const unescapeText = (s: string): string =>
  s.replace(/&(lt|gt|amp);/g, (_m, e: string) => (e === 'lt' ? '<' : e === 'gt' ? '>' : '&'))

interface Marks {
  bold: boolean
  italic: boolean
  href: string | undefined
}

/** the block's runs as placeholder text (links outermost, then bold, then italic) */
export function encodeRuns(runs: readonly InlineRun[]): EncodedBlock {
  const out: EncodedBlock = { text: '', links: [], notes: [], maths: [] }
  let open: Marks = { bold: false, italic: false, href: undefined }
  let s = ''
  const closeTo = (keepLink: boolean, keepBold: boolean) => {
    if (open.italic) s += '</i>'
    if (open.bold && !keepBold) s += '</b>'
    if (open.href !== undefined && !keepLink) s += `</a${out.links.length}>`
    open = {
      bold: open.bold && keepBold,
      italic: false,
      href: keepLink ? open.href : undefined,
    }
  }
  const moveTo = (next: Marks) => {
    if (next.href !== open.href) closeTo(false, false)
    else if (next.bold !== open.bold) closeTo(true, false)
    else if (next.italic !== open.italic) closeTo(true, true)
    else return
    if (next.href !== undefined && open.href === undefined) {
      out.links.push(next.href)
      s += `<a${out.links.length}>`
    }
    if (next.bold && !open.bold) s += '<b>'
    if (next.italic) s += '<i>'
    open = next
  }
  for (const r of runs) {
    switch (r.kind) {
      case 'text':
        if (r.text === '') break
        moveTo({ bold: r.bold === true, italic: r.italic === true, href: r.href })
        s += escapeText(r.text)
        break
      // markers and formulas never belong to a link's text
      case 'footnoteRef':
        if (open.href !== undefined) closeTo(false, false)
        out.notes.push(r)
        s += `<n${out.notes.length}/>`
        break
      case 'math':
        if (open.href !== undefined) closeTo(false, false)
        out.maths.push(r)
        s += `<m${out.maths.length}/>`
        break
      case 'lineBreak':
        s += '<br/>'
        break
    }
  }
  closeTo(false, false)
  out.text = s
  return out
}

/** a tag in returned text: pairs (b, i, aK) and single tags (nK, mK, br) */
const TAG = /<\s*(\/?)\s*(b|i|a[1-9]\d*)\s*>|<\s*(n[1-9]\d*|m[1-9]\d*|br)\s*\/\s*>/g

/** canonical tag → how often it occurs */
function tagCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const m of text.matchAll(TAG)) {
    const tag = m[3] !== undefined ? `<${m[3]}/>` : `<${m[1]}${m[2]}>`
    counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return counts
}

const sameCounts = (a: Map<string, number>, b: Map<string, number>): boolean =>
  a.size === b.size && [...a].every(([tag, n]) => b.get(tag) === n)

function pushText(runs: InlineRun[], text: string, marks: Marks): void {
  if (text === '') return
  const last = runs[runs.length - 1]
  if (
    last?.kind === 'text' &&
    (last.bold === true) === marks.bold &&
    (last.italic === true) === marks.italic &&
    last.href === marks.href
  ) {
    last.text += text
    return
  }
  const run: TextRun = { kind: 'text', text }
  if (marks.bold) run.bold = true
  if (marks.italic) run.italic = true
  if (marks.href !== undefined) run.href = marks.href
  runs.push(run)
}

/** rebuild runs from a returned translation; null when the tags do not nest */
function rebuild(block: EncodedBlock, text: string): InlineRun[] | null {
  const runs: InlineRun[] = []
  const marks: Marks = { bold: false, italic: false, href: undefined }
  let link = 0
  let at = 0
  for (const m of text.matchAll(TAG)) {
    pushText(runs, unescapeText(text.slice(at, m.index)), marks)
    at = m.index + m[0].length
    const single = m[3]
    if (single !== undefined) {
      if (single === 'br') runs.push({ kind: 'lineBreak' })
      else {
        const n = Number(single.slice(1))
        const run = single[0] === 'n' ? block.notes[n - 1] : block.maths[n - 1]
        if (!run) return null
        runs.push({ ...run })
      }
      continue
    }
    const closing = m[1] === '/'
    const name = m[2]!
    if (name === 'b' || name === 'i') {
      const key = name === 'b' ? 'bold' : 'italic'
      if (marks[key] === !closing) return null
      marks[key] = !closing
      continue
    }
    const n = Number(name.slice(1))
    if (closing) {
      if (link !== n) return null
      link = 0
      marks.href = undefined
    } else {
      const href = block.links[n - 1]
      if (link !== 0 || href === undefined) return null
      link = n
      marks.href = href
    }
  }
  pushText(runs, unescapeText(text.slice(at)), marks)
  if (marks.bold || marks.italic || link !== 0) return null
  return runs
}

/** check a returned translation against its block and rebuild its runs */
export function decodeTranslation(block: EncodedBlock, translated: string): DecodedTranslation {
  const text = translated.trim()
  if (text.replace(TAG, '').trim() === '' && block.text.replace(TAG, '').trim() !== '') {
    return { ok: false, reason: 'empty-translation' }
  }
  if (!sameCounts(tagCounts(block.text), tagCounts(text))) {
    return { ok: false, reason: 'placeholder-mismatch' }
  }
  const runs = rebuild(block, text)
  return runs ? { ok: true, runs } : { ok: false, reason: 'placeholder-mismatch' }
}
