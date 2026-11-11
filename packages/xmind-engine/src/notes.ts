import { isRecord } from './types'

/**
 * A topic's note as plain text, or null when it has none.
 *
 * A note can hold a plain form and a rich (HTML) form side by side. The plain
 * one is used as stored; a note that only has the rich form is reduced to its
 * text, so it can still be read and edited as plain text.
 *
 * Two different shapes carry that rich form. `realHTML` (what this engine
 * itself writes, and what the desktop app's own export produces) is a ready
 * HTML string, run through `htmlToPlainText` below. `html` is the shape the
 * official xmind-sdk-js writes instead: structured paragraphs of spans
 * (`{ content: { paragraphs: [{ spans: [...] }] } }`), never an HTML string,
 * so it needs its own walk (`richNoteText`) rather than `htmlToPlainText`.
 */
export function noteText(notes: unknown): string | null {
  if (!isRecord(notes)) return null
  const plain = contentOf(notes.plain)
  if (plain !== null) return plain
  const rich = contentOf(notes.realHTML)
  if (rich !== null) return htmlToPlainText(rich)
  return richNoteText(notes.html)
}

function contentOf(form: unknown): string | null {
  return isRecord(form) && typeof form.content === 'string' ? form.content : null
}

/**
 * Plain text from the xmind-sdk-js `html` note shape: one line per
 * paragraph, each the concatenated text of its spans. A hyperlink span's own
 * text comes from its nested `spans`, same as `htmlToPlainText` keeps an
 * anchor's visible text but drops the tag; an image span contributes none,
 * same as an image is dropped there too. Returns null when there is no
 * paragraph at all (an unset note, or something else entirely under `html`),
 * distinguishing "no rich form" from a rich form that is simply blank.
 */
function richNoteText(html: unknown): string | null {
  if (!isRecord(html) || !isRecord(html.content) || !Array.isArray(html.content.paragraphs)) {
    return null
  }
  let text = ''
  let sawParagraph = false
  for (const paragraph of html.content.paragraphs) {
    if (!isRecord(paragraph)) continue
    sawParagraph = true
    text += spansText(paragraph.spans) + '\n'
  }
  return sawParagraph ? text : null
}

function spansText(spans: unknown): string {
  if (!Array.isArray(spans)) return ''
  let text = ''
  for (const span of spans) {
    if (!isRecord(span)) continue
    if (typeof span.text === 'string') text += span.text
    else if (Array.isArray(span.spans)) text += spansText(span.spans) // hyperlink span
    // an image span (`image` key) contributes no text
  }
  return text
}

const ENTITIES: Readonly<Record<string, string>> = {
  nbsp: ' ',
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
}

/**
 * The text of a rich note: one line per block, tags dropped, entities decoded.
 * Works on the string alone, because the engine has no DOM to lean on.
 */
export function htmlToPlainText(html: string): string {
  return (
    html
      // a break that only holds an empty block open is not a second line
      .replace(/<br\s*\/?>(?=\s*<\/(?:div|p|li)\s*>)/gi, '')
      .replace(/<br\s*\/?>|<\/(?:div|p|li|h[1-6]|tr)\s*>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole: string, name: string) =>
        decodeEntity(name, whole),
      )
  )
}

function decodeEntity(name: string, whole: string): string {
  if (name.startsWith('#')) {
    const hex = name[1] === 'x' || name[1] === 'X'
    const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10)
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : whole
  }
  const key = name.toLowerCase()
  return Object.hasOwn(ENTITIES, key) ? ENTITIES[key]! : whole
}
