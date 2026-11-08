/**
 * Document tree → per-page structured text for the AI read path (spec §2):
 * headings as `#`, tables as Markdown pipe tables, the notes of a page in a
 * footnotes block at its end, pages kept as pictures as a short marker.
 * Headers, footers and page numbers are not in the tree, so they are not in
 * the text either.
 *
 * The text goes to a model, not to a Markdown file: inline marks (bold,
 * italic, links) are dropped and nothing is escaped except `|` in table
 * cells, so the wording stays as close to the page as the tree allows.
 * Labels are English on purpose (model input, not UI).
 *
 * Pure and environment-free: the app's structure process and the terminal
 * (`pdf read --structured`) share it.
 */
import type {
  CaptionBlock,
  DocumentTree,
  FootnoteDef,
  InlineRun,
  ListItemBlock,
  PageImageBlock,
  TableBlock,
  TocEntry,
  TreeBlock,
} from '../tree/types'

/** one page of structured text */
export interface StructuredTextPage {
  /** 1-based page number in the original document */
  page: number
  text: string
}

/** heads the notes block at the end of a page */
export const FOOTNOTES_LABEL = 'Footnotes:'
/** heads the entries of a printed table of contents (its page has no body blocks) */
export const TOC_LABEL = 'Table of contents:'
/** marks a figure; its caption follows on its own line */
export const FIGURE_MARKER = '[figure]'

/** the line that stands for a page kept as one picture */
export function pageImageNote(page: number, reason: PageImageBlock['reason']): string {
  return reason === 'scanned'
    ? `[page ${page} is an image (scanned); no text layer]`
    : `[page ${page} is an image; its text layer could not be read reliably]`
}

/** what one page is made of */
export interface StructuredPageInput {
  /** 1-based original page number */
  page: number
  /** the page's blocks in reading order (page breaks are ignored) */
  blocks: readonly TreeBlock[]
  /** notes whose text sits on this page */
  footnotes?: readonly FootnoteDef[]
  /** printed table-of-contents entries on this page */
  toc?: readonly TocEntry[]
  /** printed marker of a note id; defaults to the note's own marker, then the id */
  footnoteMarker?: (id: string) => string
}

const LIST_NUMBER_RE = /^\(?(\d{1,9})[.)]?\)?$/

type InlineMode = 'block' | 'heading' | 'table'

function inlineText(
  runs: readonly InlineRun[],
  mode: InlineMode,
  marker: (id: string) => string,
): string {
  let out = ''
  for (const run of runs) {
    switch (run.kind) {
      case 'text':
        out += run.text.replace(/[ \t]*[\r\n]+[ \t]*/g, ' ')
        break
      case 'lineBreak':
        out += mode === 'block' ? '\n' : mode === 'table' ? '<br>' : ' '
        break
      case 'math':
        out += `$${run.latex.replace(/\s*[\r\n]+\s*/g, ' ').trim()}$`
        break
      case 'footnoteRef':
        out += `[^${marker(run.id)}]`
        break
    }
  }
  const text = out
    .split('\n')
    .map((line) => line.trim())
    .filter((line, k, lines) => line !== '' || (k > 0 && lines[k - 1] !== ''))
    .join('\n')
    .trim()
  return mode === 'table' ? text.replace(/\|/g, '\\|') : text
}

class PageWriter {
  private readonly parts: string[] = []
  /** the list being written: numbers and kinds by level */
  private list: { ordered: boolean[]; counters: number[] } | null = null

  constructor(private readonly marker: (id: string) => string) {}

  private inline(runs: readonly InlineRun[], mode: InlineMode = 'block'): string {
    return inlineText(runs, mode, this.marker)
  }

  private push(text: string): void {
    if (text === '') return
    this.list = null
    this.parts.push(text)
  }

  block(block: TreeBlock): void {
    switch (block.kind) {
      case 'pageBreak':
        return
      case 'heading': {
        const text = this.inline(block.runs, 'heading')
        if (text) this.push(`${'#'.repeat(block.level)} ${text}`)
        return
      }
      case 'paragraph':
        this.push(this.inline(block.runs))
        return
      case 'listItem':
        this.listItem(block)
        return
      case 'table':
        this.table(block)
        return
      case 'image':
        this.captioned(FIGURE_MARKER, block.caption, block.captionTranslation)
        return
      case 'math': {
        const latex = block.latex.trim()
        if (latex) this.push(`$$\n${latex}\n$$`)
        return
      }
      case 'pageImage':
        this.push(pageImageNote(block.page, block.reason))
        return
    }
  }

  private listItem(block: ListItemBlock): void {
    const text = this.inline(block.runs)
    if (text === '') return
    const list = this.list ?? { ordered: [], counters: [] }
    // at most one level deeper than the previous item
    const level = Math.min(Math.max(0, Math.floor(block.level)), list.ordered.length)
    const continues = level < list.ordered.length && list.ordered[level] === block.ordered
    const printed = block.marker?.trim() ?? ''
    const number = LIST_NUMBER_RE.exec(printed)?.[1]
    const n = number !== undefined ? Number(number) : continues ? list.counters[level]! + 1 : 1
    list.ordered.length = level
    list.counters.length = level
    list.ordered.push(block.ordered)
    list.counters.push(n)
    // an ordered marker that is not a number ("(a)", "iv.") is kept as printed
    const marker = !block.ordered ? '-' : number === undefined && printed ? printed : `${n}.`
    const indent = '  '.repeat(level)
    const line = `${indent}${marker} ${text.replace(/\n/g, `\n${indent}  `)}`
    if (this.list === list) {
      this.parts[this.parts.length - 1] += `\n${line}`
    } else {
      this.push(line)
      this.list = list
    }
  }

  private table(block: TableBlock): void {
    const { rowCount, colCount, cells } = block.table
    let body = ''
    if (rowCount > 0 && colCount > 0) {
      const grid = Array.from({ length: rowCount }, () => new Array<string>(colCount).fill(''))
      // merged ranges are un-merged: the content stays in the first cell (as in the Markdown writer)
      for (const cell of cells) {
        if (cell.row < 0 || cell.row >= rowCount || cell.col < 0 || cell.col >= colCount) continue
        grid[cell.row]![cell.col] = cell.paragraphs
          .map((p) => this.inline(p, 'table'))
          .filter((p) => p !== '')
          .join('<br>')
      }
      const row = (values: string[]): string => `| ${values.join(' | ')} |`
      body = [row(grid[0]!), row(grid[0]!.map(() => '---')), ...grid.slice(1).map(row)].join('\n')
    }
    this.captioned(body, block.caption)
  }

  /** a caption sits where it sat in the source; a translation follows the original */
  private captioned(body: string, ...captions: (CaptionBlock | undefined)[]): void {
    const present = captions.filter((c): c is CaptionBlock => c !== undefined)
    const above = present.filter((c) => c.position === 'above')
    const below = present.filter((c) => c.position !== 'above')
    for (const c of above) this.push(this.inline(c.runs))
    this.push(body)
    for (const c of below) this.push(this.inline(c.runs))
  }

  toc(entries: readonly TocEntry[]): void {
    if (entries.length === 0) return
    const lines = entries.map((e) => {
      const indent = '  '.repeat(Math.max(0, Math.floor(e.level) - 1))
      const label = e.pageLabel.trim()
      return `${indent}- ${e.title.trim()}${label ? ` … ${label}` : ''}`
    })
    this.push(`${TOC_LABEL}\n${lines.join('\n')}`)
  }

  footnotes(notes: readonly FootnoteDef[]): void {
    const lines: string[] = []
    for (const note of notes) {
      const text = note.blocks
        .map((p) => this.inline(p.runs).replace(/\n/g, ' '))
        .filter((p) => p !== '')
        .join(' ')
      lines.push(`[^${this.marker(note.id)}]${text ? ` ${text}` : ''}`)
    }
    if (lines.length > 0) this.push(`${FOOTNOTES_LABEL}\n${lines.join('\n')}`)
  }

  text(): string {
    return this.parts.join('\n\n')
  }
}

/** structured text of one page */
export function formatStructuredPage(input: StructuredPageInput): string {
  const notes = input.footnotes ?? []
  const own = new Map(notes.map((n) => [n.id, n.marker]))
  const marker = input.footnoteMarker ?? ((id: string) => own.get(id)?.trim() || id)
  const writer = new PageWriter(marker)
  for (const block of input.blocks) writer.block(block)
  writer.toc(input.toc ?? [])
  writer.footnotes(notes)
  return writer.text()
}

/**
 * Printed note markers for the whole tree: the note's own marker, else the
 * one printed at its first reference, else a number in reading order.
 */
function footnoteMarkers(tree: DocumentTree): (id: string) => string {
  const markers = new Map<string, string>()
  const refMarkers = new Map<string, string>()
  const order: string[] = []
  const visit = (runs: readonly InlineRun[]): void => {
    for (const r of runs) {
      if (r.kind !== 'footnoteRef') continue
      if (!order.includes(r.id)) order.push(r.id)
      if (r.marker?.trim() && !refMarkers.has(r.id)) refMarkers.set(r.id, r.marker.trim())
    }
  }
  for (const b of tree.blocks) {
    if (b.kind === 'table') {
      for (const c of b.table.cells) for (const p of c.paragraphs) visit(p)
    } else if ('runs' in b) {
      visit(b.runs)
    }
    if ((b.kind === 'table' || b.kind === 'image') && b.caption) visit(b.caption.runs)
  }
  for (const n of tree.footnotes) if (!order.includes(n.id)) order.push(n.id)
  const own = new Map(tree.footnotes.map((n) => [n.id, n.marker?.trim()]))
  let next = 0
  for (const id of order) {
    const m = own.get(id) || refMarkers.get(id)
    markers.set(id, m || String(++next))
  }
  return (id) => markers.get(id) ?? id
}

/** structured text of every analyzed page, in page order */
export function treeToStructuredText(tree: DocumentTree): StructuredTextPage[] {
  const pages = new Set(tree.pages.map((p) => p.page))
  const blocks = new Map<number, TreeBlock[]>()
  for (const b of tree.blocks) {
    if (b.kind === 'pageBreak') {
      pages.add(b.page)
      continue
    }
    pages.add(b.page)
    const list = blocks.get(b.page)
    if (list) list.push(b)
    else blocks.set(b.page, [b])
  }
  const notes = new Map<number, FootnoteDef[]>()
  const seen = new Set<string>()
  for (const n of tree.footnotes) {
    if (seen.has(n.id)) continue
    seen.add(n.id)
    pages.add(n.page)
    const list = notes.get(n.page)
    if (list) list.push(n)
    else notes.set(n.page, [n])
  }
  const toc = new Map<number, TocEntry[]>()
  for (const e of tree.toc) {
    if (!pages.has(e.tocPage)) continue
    const list = toc.get(e.tocPage)
    if (list) list.push(e)
    else toc.set(e.tocPage, [e])
  }
  const footnoteMarker = footnoteMarkers(tree)
  return [...pages]
    .sort((a, b) => a - b)
    .map((page) => ({
      page,
      text: formatStructuredPage({
        page,
        blocks: blocks.get(page) ?? [],
        footnotes: notes.get(page) ?? [],
        toc: toc.get(page) ?? [],
        footnoteMarker,
      }),
    }))
}
