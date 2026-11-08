/**
 * The annotation panel's export (reading-assist spec 4.3): the filtered list
 * as Markdown in the spec's exact shape, the same as simple HTML for a Word
 * document, and opening either through the existing `createDocument` channel.
 * No AI is involved. Pure apart from `openAnnotDocument`'s one call.
 */
import type { CreateDocumentRequest, CreateDocumentResult } from '../../shared/ipc'
import type { TFunc } from '../i18n/locale'
import type { AnnotItem } from './items'

interface Entry {
  /** the blockquote: shown text, then "— <kind>" */
  quote?: { text: string; by: string }
  /** paragraphs after the quote (a card's answer, a note's text and replies) */
  paragraphs: string[]
}

interface Group {
  heading: string
  entries: Entry[]
}

function entryOf(item: AnnotItem, t: TFunc): Entry {
  if (item.kind === 'note') {
    const texts = [item.memo ?? item.text, ...(item.replyTexts ?? [])]
    return { paragraphs: texts.map((text) => t('apMdNote', { text })) }
  }
  const by = item.category ? `${item.kindLabel} · ${item.category}` : item.kindLabel
  return {
    quote: { text: item.text, by },
    paragraphs: item.body ? [item.body] : [],
  }
}

/** groups in list order: one per page (first appearance), the not-found items last */
function groupsOf(items: readonly AnnotItem[], t: TFunc): Group[] {
  const byPage = new Map<number, Group>()
  const lost: Group = { heading: t('apNotFound'), entries: [] }
  for (const item of items) {
    if (item.pageNo === null) {
      lost.entries.push(entryOf(item, t))
      continue
    }
    let g = byPage.get(item.pageNo)
    if (!g) byPage.set(item.pageNo, (g = { heading: `p.${item.pageNo}`, entries: [] }))
    g.entries.push(entryOf(item, t))
  }
  const groups = [...byPage.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g)
  return lost.entries.length > 0 ? [...groups, lost] : groups
}

/** the new document's title: "<document title> — <"Annotations" in the UI language>" */
export const exportTitle = (title: string, t: TFunc): string => `${title} — ${t('apCollection')}`

const lines = (s: string): string[] => s.split(/\r\n|\r|\n/)

/**
 * A quoted line as plain text: a line that starts like a Markdown block (a
 * heading, a list item, a nested quote, a numbered item) gets its marker
 * escaped, so the passage stays one quote. Other lines are kept as they are.
 */
const quoteLine = (line: string): string =>
  line.replace(/^(\s*)([#>*+-])/, '$1\\$2').replace(/^(\s*\d+)([.)])/, '$1\\$2')

/**
 * ```markdown
 * # <title> — <collection>
 *
 * ## p.3
 *
 * > marked text
 * >
 * > — Highlight
 *
 * Note: the note
 * ```
 */
export function annotMarkdown(o: { title: string; items: readonly AnnotItem[]; t: TFunc }): string {
  const out: string[] = [`# ${exportTitle(o.title, o.t)}`]
  for (const g of groupsOf(o.items, o.t)) {
    out.push('', `## ${g.heading}`)
    for (const e of g.entries) {
      if (e.quote) {
        out.push('')
        const text = e.quote.text.trim()
        if (text) out.push(...lines(text).map((l) => (l ? `> ${quoteLine(l)}` : '>')), '>')
        out.push(`> — ${e.quote.by}`)
      }
      for (const p of e.paragraphs) out.push('', p)
    }
  }
  return `${out.join('\n')}\n`
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const htmlText = (s: string): string => lines(s).map(esc).join('<br>')

/** the same content as simple HTML (headings, blockquotes, paragraphs) for a Word document */
export function annotHtml(o: { title: string; items: readonly AnnotItem[]; t: TFunc }): string {
  const out: string[] = [`<h1>${esc(exportTitle(o.title, o.t))}</h1>`]
  for (const g of groupsOf(o.items, o.t)) {
    out.push(`<h2>${esc(g.heading)}</h2>`)
    for (const e of g.entries) {
      if (e.quote) {
        const text = e.quote.text.trim()
        out.push(
          `<blockquote>${text ? `<p>${htmlText(text)}</p>` : ''}<p>— ${esc(e.quote.by)}</p></blockquote>`,
        )
      }
      for (const p of e.paragraphs) out.push(`<p>${htmlText(p)}</p>`)
    }
  }
  return out.join('\n')
}

export type CreateDocument = (request: CreateDocumentRequest) => Promise<CreateDocumentResult>

/** "Open as Markdown document" / "Open as Word document": a new file in the default folder, a new tab */
export async function openAnnotDocument(
  type: 'md' | 'docx',
  o: { title: string; items: readonly AnnotItem[]; t: TFunc; createDocument: CreateDocument },
): Promise<CreateDocumentResult> {
  const content = type === 'md' ? annotMarkdown(o) : annotHtml(o)
  try {
    return await o.createDocument({ type, title: exportTitle(o.title, o.t), content })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
