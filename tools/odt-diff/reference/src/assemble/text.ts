/**
 * Plain text of an ODT for AI attachments: paragraphs and headings in
 * document order, tables row by row (cells separated by tabs, the cell's
 * paragraphs and nested tables joined by spaces), tables Hancom puts in text
 * boxes after the paragraph holding them, and notes at the end under their
 * citation. Deleted tracked text and comments are left out.
 */
import { openOdt } from '../core/open'
import { type ElementFrame, decodeXmlEntities, walkElements } from '../core/xml'

/** A paragraph being collected, with the tables framed inside it. */
interface Para {
  kind: 'para'
  text: string
  /** leading / collapsed white space state (ODF white-space rules) */
  ws: boolean
  after: string[]
}
interface Cell {
  kind: 'cell'
  parts: string[]
}
interface Table {
  kind: 'table'
  rows: string[][]
}
interface Note {
  kind: 'note'
  /** the paragraph holding the citation and the citation's place in its text */
  host: Para | null
  at: number
  parts: string[]
}
type Ctx = Para | Cell | Table | Note

const SKIP = new Set([
  'text:tracked-changes',
  'office:annotation',
  'office:annotation-end',
  'text:note-citation',
  'text:sequence-decls',
  'office:forms',
  'text:soft-page-break',
  'svg:title',
  'svg:desc',
  'office:binary-data',
  'draw:object-ole',
  'office:event-listeners',
])

/** Index templates (`text:table-of-content-source` …) hold template text, not content. */
const skipped = (name: string) => SKIP.has(name) || /^text:[\w-]+-source$/.test(name)

/** The document's text. Throws only `OdtOpenError` (encrypted, not an ODT, corrupt). */
export async function odtToText(odtBytes: Uint8Array): Promise<string> {
  const doc = await openOdt(odtBytes)
  const xml = doc.contentXml
  const text = doc.body.text
  const out: string[] = []
  const notes: string[] = []
  const stack: Ctx[] = []
  const nearest = <K extends Ctx['kind']>(kind: K): Extract<Ctx, { kind: K }> | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].kind === kind) return stack[i] as never
    return undefined
  }
  /** Where a finished block of text goes: the enclosing cell/note/paragraph, else the output. */
  const emit = (line: string) => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const c = stack[i]
      if (c.kind === 'cell' || c.kind === 'note') {
        c.parts.push(line)
        return
      }
      if (c.kind === 'para') {
        c.after.push(line)
        return
      }
    }
    out.push(line)
  }
  const addText = (s: string) => {
    const p = stack[stack.length - 1]
    if (!p || p.kind !== 'para') return
    for (const ch of s) {
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        if (!p.ws) p.text += ' '
        p.ws = true
      } else {
        p.text += ch
        p.ws = false
      }
    }
  }
  const literal = (s: string) => {
    const p = stack[stack.length - 1]
    if (!p || p.kind !== 'para') return
    p.text += s
    p.ws = false
  }
  const noteCitation = (el: ElementFrame): string => {
    const m = /<(?:[\w-]+:)?note-citation\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?note-citation>/.exec(
      xml.slice(el.openEnd, el.closeStart),
    )
    return m ? decodeXmlEntities(m[1].replace(/<[^>]*>/g, '')).trim() : ''
  }

  walkElements(
    xml,
    doc.body.prefixes,
    {
      open(el) {
        if (skipped(el.name)) return 'skip'
        switch (el.name) {
          case 'text:p':
          case 'text:h':
            stack.push({ kind: 'para', text: '', ws: true, after: [] })
            el.data = true
            return
          case 'text:s': {
            const c = /text:c="(\d+)"/.exec(xml.slice(el.start, el.openEnd))?.[1]
            literal(' '.repeat(Math.min(1000, Math.max(1, c ? parseInt(c, 10) : 1))))
            return 'skip'
          }
          case 'text:tab':
            literal('\t')
            return 'skip'
          case 'text:line-break':
            literal('\n')
            return 'skip'
          case 'table:table':
            stack.push({ kind: 'table', rows: [] })
            el.data = true
            return
          case 'table:table-row': {
            nearest('table')?.rows.push([])
            return
          }
          case 'table:table-cell':
          case 'table:covered-table-cell':
            stack.push({ kind: 'cell', parts: [] })
            el.data = true
            return
          case 'text:note': {
            const top = stack[stack.length - 1]
            const host = top?.kind === 'para' ? top : null
            stack.push({ kind: 'note', host, at: host ? host.text.length : 0, parts: [] })
            el.data = true
            return
          }
        }
      },
      close(el) {
        if (!el.data) return
        const c = stack.pop()
        if (!c) return
        if (c.kind === 'para') {
          const line = c.text.replace(/ +$/, '')
          // a paragraph that only hosts framed tables or text boxes gives no line of its own
          if (line !== '' || !c.after.length) emit(line)
          for (const a of c.after) emit(a)
        } else if (c.kind === 'cell') {
          const table = nearest('table')
          const row = table?.rows[table.rows.length - 1]
          const value = c.parts
            .filter((p) => p.trim() !== '')
            .join(' ')
            .replace(/[\t\n]+/g, ' ')
          if (row && el.name === 'table:table-cell') row.push(value)
        } else if (c.kind === 'table') {
          const lines = c.rows.map((r) => r.join('\t')).filter((l) => l.trim() !== '')
          if (lines.length) emit(lines.join('\n'))
        } else if (c.kind === 'note') {
          const citation = noteCitation(el)
          if (c.host && citation) {
            c.host.text = c.host.text.slice(0, c.at) + citation + c.host.text.slice(c.at)
            c.host.ws = false
          }
          const body = c.parts.filter((p) => p.trim() !== '').join(' ')
          notes.push(citation ? `${citation} ${body}` : body)
        }
      },
      other(kind, start, end) {
        if (kind === 'text') addText(decodeXmlEntities(xml.slice(start, end)))
        else if (kind === 'cdata') addText(xml.slice(start + 9, Math.max(start + 9, end - 3)))
      },
    },
    text.openEnd,
    text.closeStart,
  )
  const body = out.join('\n')
  return notes.length ? `${body}\n\n${notes.join('\n')}` : body
}
