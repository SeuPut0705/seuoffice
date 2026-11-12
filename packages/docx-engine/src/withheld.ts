import { placeholderSource } from '@seuoffice/agent-core/redact-core'
import { decodeEntities } from './parse-xml-text'
import { escapeXmlText } from './xml-utils'

/**
 * Text a person marked "hidden from AI" outside the body: in a header, a
 * footer, a comment or a note. The document editor writes the mark as
 * `<go:redact w:label="…"/>` in a run's rPr (other spellings: MARK_RE); the body reads it into an editor
 * mark (apps/docs editor/convert.ts), and these parts read it here, by the
 * same rule, so that a model is never handed the words.
 */

/**
 * The mark under any prefix or none. The editor writes `go:redact`, but
 * another writer may bind the namespace to another prefix, declare it as the
 * mark's default, or inherit it from an element around it; a reader that
 * cannot tell which withholds the words rather than hand them over.
 */
const MARK_RE = /<(?:[\w.-]+:)?redact\b/
const LABEL_RE = /<(?:[\w.-]+:)?redact\b[^>]*?\sw:label="([^"]*)"/

/** The label of a run whose rPr carries the mark, or null when the run reads as itself. */
export function withheldLabelOf(rPrXml: string | undefined): string | null {
  if (!rPrXml || !MARK_RE.test(rPrXml)) return null
  return decodeEntities(LABEL_RE.exec(rPrXml)?.[1] ?? 'private')
}

/** What a model reads for an entry whose marks cannot all be read: the whole entry is withheld. */
export const WITHHELD_ENTRY_TEXT = placeholderSource('private')

/** a run's open tag (not w:rPr, w:rFonts…), self-closing or not, and its close tag */
const RUN_TAG_RE = /<w:r(?:\s[^>]*?)?(\/)?>|<\/w:r>/g
/** the rPr that opens a run, past the white space and comments a pretty-printed part puts first */
const RUN_RPR_RE = /(?:\s+|<!--[\s\S]*?-->)*(<w:rPr\b[^>]*?(?:\/>|>[\s\S]*?<\/w:rPr>))/y
/** a paragraph's properties: a mark on its paragraph mark withholds no words */
const PPR_RE = /<w:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/w:pPr>)/g
/** every trace of the mark, under any prefix or none */
const MARK_TRACE_RE = new RegExp(MARK_RE.source, 'g')

function runRPr(xml: string, start: number): string | undefined {
  RUN_RPR_RE.lastIndex = xml.indexOf('>', start) + 1
  return RUN_RPR_RE.exec(xml)?.[1]
}

/**
 * One entry's XML (a comment, a note, a content control) with every run
 * hidden from AI replaced by a plain run that holds its placeholder; runs next
 * to each other under one label give one placeholder, as a span in the body
 * does. A hidden run holding other runs (a text box in a drawing) is replaced
 * whole. Reading the result's text gives the entry as a model may read it.
 *
 * Every trace of the mark has to be accounted for: in the properties of a
 * run, which is then withheld, or on a paragraph mark, which has no words. A
 * trace anywhere else gives null, and the caller withholds the whole entry
 * (WITHHELD_ENTRY_TEXT) rather than guess which words it meant.
 */
export function withheldAsPlaceholders(xml: string): string | null {
  if (!MARK_RE.test(xml)) return xml
  const hidden: Array<{ start: number; end: number; label: string }> = []
  const open: number[] = []
  for (const m of xml.matchAll(RUN_TAG_RE)) {
    const at = m.index!
    if (m[0] === '</w:r>') {
      const start = open.pop()
      if (start === undefined) continue
      const end = at + m[0].length
      const label = withheldLabelOf(runRPr(xml, start))
      if (label === null) continue
      // an outer hidden run swallows the hidden runs inside it
      while (hidden.length > 0 && hidden[hidden.length - 1]!.start > start) hidden.pop()
      hidden.push({ start, end, label })
    } else if (!m[1]) {
      open.push(at)
    }
  }
  const understood = [
    ...hidden,
    ...[...xml.matchAll(PPR_RE)].map((m) => ({ start: m.index!, end: m.index! + m[0].length })),
  ]
  for (const trace of xml.matchAll(MARK_TRACE_RE)) {
    const at = trace.index!
    if (!understood.some((range) => at >= range.start && at < range.end)) return null
  }
  let out = ''
  let at = 0
  for (const [i, span] of hidden.entries()) {
    const previous = hidden[i - 1]
    const joins =
      previous !== undefined && previous.end === span.start && previous.label === span.label
    out += xml.slice(at, span.start)
    if (!joins) {
      out += `<w:r><w:t xml:space="preserve">${escapeXmlText(placeholderSource(span.label))}</w:t></w:r>`
    }
    at = span.end
  }
  return out + xml.slice(at)
}
