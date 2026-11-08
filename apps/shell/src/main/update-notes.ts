import { parseFragment } from 'parse5'
import type {
  UpdateNoteBlock,
  UpdateNoteRun,
  UpdateNoteSection,
  UpdateReleaseNotes,
} from '../shared/update-api'

/**
 * Converts the release body the GitHub update feed hands over — GitHub's own
 * HTML rendering of the release description — into the small, safe block tree
 * the update window draws (docs/plans/update-details.md). Remote text never
 * reaches the window as HTML: here it becomes plain runs only; images, links
 * and unknown markup lose everything but their text; scripts and styles are
 * dropped whole; size caps keep a runaway body out of the UI state.
 *
 * The feed entry is the only source: nothing is fetched, executed or opened.
 * Pure module (no Electron imports) so it runs under plain node in tests.
 */

/** raw feed content beyond this is cut before parsing */
const MAX_RAW_CHARS = 256 * 1024
/** total characters of converted note text; trailing content is dropped to fit */
const MAX_TOTAL_CHARS = 48_000
const MAX_SECTIONS = 12
const MAX_VERSION_CHARS = 64

const SKIP_TAGS = new Set(['script', 'style', 'img'])
const HEADING_RE = /^h([1-6])$/

/** minimal shape of the parse5 tree nodes this module walks */
interface TreeNode {
  nodeName: string
  tagName?: string
  value?: string
  childNodes?: TreeNode[]
}

interface RunFlags {
  strong?: boolean
  code?: boolean
}

function isElement(node: TreeNode): node is TreeNode & { tagName: string } {
  return typeof node.tagName === 'string'
}

function childNodesOf(node: TreeNode | undefined): TreeNode[] {
  return node?.childNodes ?? []
}

/**
 * `input` is `UpdateInfo.releaseNotes` of electron-updater: a single HTML
 * string, a list of `{version, note}` entries (full changelog), or null.
 * Returns null when there is nothing worth showing.
 */
export function normalizeReleaseNotes(input: unknown): UpdateReleaseNotes | null {
  const notes = noteInputs(input)
  if (notes.length === 0) return null

  let truncated = notes.length > MAX_SECTIONS
  const sections: UpdateNoteSection[] = []
  for (const note of notes.slice(0, MAX_SECTIONS)) {
    let html = note.html
    if (html.length > MAX_RAW_CHARS) {
      html = html.slice(0, MAX_RAW_CHARS)
      truncated = true
    }
    const blocks = htmlToBlocks(html)
    if (blocks.length > 0) sections.push({ version: note.version, blocks })
  }
  if (sections.length === 0) return null

  const capped = capTotalChars(sections)
  const kept = capped.sections.filter((section) => section.blocks.length > 0)
  if (kept.length === 0) return null
  return { sections: kept, truncated: truncated || capped.truncated }
}

function noteInputs(input: unknown): Array<{ version: string | null; html: string }> {
  if (typeof input === 'string') {
    return hasContent(input) ? [{ version: null, html: input }] : []
  }
  if (!Array.isArray(input)) return []
  const notes: Array<{ version: string | null; html: string }> = []
  for (const item of input) {
    if (item === null || typeof item !== 'object') continue
    const note = (item as { note?: unknown }).note
    if (typeof note !== 'string' || !hasContent(note)) continue
    const rawVersion = (item as { version?: unknown }).version
    const version =
      typeof rawVersion === 'string' && rawVersion.trim() !== ''
        ? rawVersion.trim().slice(0, MAX_VERSION_CHARS)
        : null
    notes.push({ version, html: note })
  }
  return notes
}

/** GitHub reports a release without a body as "No content." */
function hasContent(html: string): boolean {
  const trimmed = html.trim()
  return trimmed !== '' && trimmed !== 'No content.'
}

function htmlToBlocks(html: string): UpdateNoteBlock[] {
  const fragment = parseFragment(html) as unknown as TreeNode
  const blocks: UpdateNoteBlock[] = []
  collectBlocks(childNodesOf(fragment), blocks)
  return blocks
}

function collectBlocks(nodes: TreeNode[], blocks: UpdateNoteBlock[]): void {
  for (const node of nodes) {
    if (node.nodeName === '#text') {
      // the newlines GitHub puts between block tags are not paragraphs
      const text = inlineText(node.value ?? '').trim()
      if (text !== '') blocks.push({ kind: 'paragraph', runs: [{ text }] })
      continue
    }
    if (!isElement(node)) continue
    const tag = node.tagName.toLowerCase()
    if (SKIP_TAGS.has(tag)) continue
    const heading = HEADING_RE.exec(tag)
    if (heading !== null) {
      const runs = finalizeRuns(collectRuns(childNodesOf(node), {}))
      if (runs.length > 0) {
        blocks.push({ kind: 'heading', level: headingLevel(heading[1]), runs })
      }
      continue
    }
    switch (tag) {
      case 'p':
      case 'blockquote': {
        const runs = finalizeRuns(collectRuns(childNodesOf(node), {}))
        if (runs.length > 0) blocks.push({ kind: 'paragraph', runs })
        break
      }
      case 'ul':
      case 'ol': {
        const items = listItems(node)
        if (items.length > 0) blocks.push({ kind: 'list', ordered: tag === 'ol', items })
        break
      }
      case 'pre': {
        const text = rawText(node)
          .replace(/^\n+/, '')
          .replace(/[ \n]+$/, '')
        if (text !== '') blocks.push({ kind: 'paragraph', runs: [{ text, code: true }] })
        break
      }
      default:
        // div, details, table…: keep their blocks, drop the wrapper
        collectBlocks(childNodesOf(node), blocks)
        break
    }
  }
}

function headingLevel(value: string | undefined): 1 | 2 | 3 {
  const level = Number(value)
  return (level <= 1 ? 1 : level === 2 ? 2 : 3) as 1 | 2 | 3
}

function listItems(node: TreeNode): UpdateNoteRun[][] {
  const items: UpdateNoteRun[][] = []
  for (const child of childNodesOf(node)) {
    if (!isElement(child) || child.tagName.toLowerCase() !== 'li') continue
    const runs = finalizeRuns(collectRuns(childNodesOf(child), {}))
    if (runs.length > 0) items.push(runs)
  }
  return items
}

/** collects the inline runs of one block, flattening nested lists into text */
function collectRuns(nodes: TreeNode[], flags: RunFlags): UpdateNoteRun[] {
  const runs: UpdateNoteRun[] = []
  const push = (text: string, f: RunFlags): void => {
    if (text === '') return
    const run: UpdateNoteRun = { text }
    if (f.strong === true) run.strong = true
    if (f.code === true) run.code = true
    runs.push(run)
  }
  const walk = (list: TreeNode[], f: RunFlags): void => {
    for (const node of list) {
      if (node.nodeName === '#text') {
        push(inlineText(node.value ?? ''), f)
        continue
      }
      if (!isElement(node)) continue
      const tag = node.tagName.toLowerCase()
      if (SKIP_TAGS.has(tag)) continue
      switch (tag) {
        case 'br':
          push('\n', f)
          break
        case 'strong':
        case 'b':
          walk(childNodesOf(node), { ...f, strong: true })
          break
        case 'code':
          walk(childNodesOf(node), { ...f, code: true })
          break
        case 'ul':
        case 'ol': {
          for (const item of listItems(node)) {
            push('\n', f)
            for (const run of item) push(run.text, { strong: run.strong, code: run.code })
          }
          break
        }
        default:
          // a, em, span, del, unknown: keep the text, whatever the wrapper
          walk(childNodesOf(node), f)
          break
      }
    }
  }
  walk(nodes, flags)
  return runs
}

/** merges adjacent runs with equal flags and trims the block's edges */
function finalizeRuns(raw: UpdateNoteRun[]): UpdateNoteRun[] {
  const runs: UpdateNoteRun[] = []
  for (const run of raw) {
    const prev = runs[runs.length - 1]
    let text = run.text
    if (prev !== undefined && /[ \n]$/.test(prev.text)) text = text.replace(/^ +/, '')
    if (text === '') continue
    const strong = run.strong === true
    const code = run.code === true
    if (prev !== undefined && (prev.strong === true) === strong && (prev.code === true) === code) {
      prev.text += text
      continue
    }
    const merged: UpdateNoteRun = { text }
    if (strong) merged.strong = true
    if (code) merged.code = true
    runs.push(merged)
  }
  while (runs.length > 0 && (runs[0]!.text = runs[0]!.text.replace(/^[ \n]+/, '')) === '')
    runs.shift()
  while (runs.length > 0) {
    const last = runs[runs.length - 1]!
    last.text = last.text.replace(/[ \n]+$/, '')
    if (last.text === '') runs.pop()
    else break
  }
  return runs
}

function inlineText(value: string): string {
  return value.replace(/\s+/g, ' ')
}

/** text of a <pre> as written, newlines kept */
function rawText(node: TreeNode): string {
  let out = ''
  const walk = (list: TreeNode[]): void => {
    for (const child of list) {
      if (child.nodeName === '#text') {
        out += child.value ?? ''
        continue
      }
      if (!isElement(child)) continue
      const tag = child.tagName.toLowerCase()
      if (SKIP_TAGS.has(tag)) continue
      if (tag === 'br') out += '\n'
      else walk(childNodesOf(child))
    }
  }
  walk(childNodesOf(node))
  return out
}

function capTotalChars(sections: UpdateNoteSection[]): {
  sections: UpdateNoteSection[]
  truncated: boolean
} {
  let total = countChars(sections)
  if (total <= MAX_TOTAL_CHARS) return { sections, truncated: false }
  const trimmed = sections.map((section) => ({ ...section, blocks: [...section.blocks] }))
  while (total > MAX_TOTAL_CHARS) {
    const section = trimmed[trimmed.length - 1]
    if (section === undefined) break
    if (section.blocks.length === 0) {
      trimmed.pop()
      continue
    }
    const index = section.blocks.length - 1
    const block = section.blocks[index]!
    const withBlocks = trimmed.filter((candidate) => candidate.blocks.length > 0)
    if (withBlocks.length === 1 && withBlocks[0]!.blocks.length === 1) {
      // a single runaway block must not disappear whole: keep its head
      section.blocks[index] = blockWithinBudget(block, MAX_TOTAL_CHARS)
      break
    }
    if (block.kind === 'list' && block.items.length > 1) {
      const items = [...block.items]
      total -= countRuns(items.pop()!)
      section.blocks[index] = { ...block, items }
      continue
    }
    section.blocks.splice(index, 1)
    total -= countBlock(block)
  }
  return { sections: trimmed, truncated: true }
}

/** a copy of the block cut to at most `budget` characters of text */
function blockWithinBudget(block: UpdateNoteBlock, budget: number): UpdateNoteBlock {
  if (block.kind === 'list') {
    const items: UpdateNoteRun[][] = []
    let used = 0
    for (const item of block.items) {
      const kept = runsWithinBudget(item, budget - used)
      if (kept.length === 0) break
      items.push(kept)
      used += countRuns(kept)
    }
    return { kind: 'list', ordered: block.ordered, items }
  }
  const runs = runsWithinBudget(block.runs, budget)
  if (block.kind === 'heading') return { kind: 'heading', level: block.level, runs }
  return { kind: 'paragraph', runs }
}

function runsWithinBudget(runs: UpdateNoteRun[], budget: number): UpdateNoteRun[] {
  const kept: UpdateNoteRun[] = []
  let used = 0
  for (const run of runs) {
    if (used >= budget) break
    const text = run.text.slice(0, budget - used)
    if (text === '') continue
    const copy: UpdateNoteRun = { text }
    if (run.strong === true) copy.strong = true
    if (run.code === true) copy.code = true
    kept.push(copy)
    used += text.length
  }
  return kept
}

function countChars(sections: UpdateNoteSection[]): number {
  let total = 0
  for (const section of sections) for (const block of section.blocks) total += countBlock(block)
  return total
}

function countBlock(block: UpdateNoteBlock): number {
  if (block.kind === 'list') {
    let total = 0
    for (const item of block.items) total += countRuns(item)
    return total
  }
  return countRuns(block.runs)
}

function countRuns(runs: UpdateNoteRun[]): number {
  let total = 0
  for (const run of runs) total += run.text.length
  return total
}
