import { placeholderSource } from '@seuoffice/agent-core/redact-core'
import { REDACT_EL } from '@seuoffice/agent-core/redact-range'
import { decodeEntities } from './parse-xml-text'
import { escapeXmlText } from './xml-utils'

/**
 * Text a person marked "hidden from AI" outside the body: in a header, a
 * footer, a comment or a note. The document editor writes the mark as
 * `<go:redact w:label="…"/>` in a run's rPr; the body reads it into an editor
 * mark (apps/docs editor/convert.ts), and these parts read it here, by the
 * same rule, so that a model is never handed the words.
 */

const LABEL_RE = new RegExp(`<${REDACT_EL}\\b[^>]*\\bw:label="([^"]*)"`)

/** The label of a run whose rPr carries the mark, or null when the run reads as itself. */
export function withheldLabelOf(rPrXml: string | undefined): string | null {
  if (!rPrXml?.includes(`<${REDACT_EL}`)) return null
  return decodeEntities(LABEL_RE.exec(rPrXml)?.[1] ?? 'private')
}

/** a run's open tag (not w:rPr, w:rFonts…), self-closing or not, and its close tag */
const RUN_TAG_RE = /<w:r(?:\s[^>]*?)?(\/)?>|<\/w:r>/g
/** the rPr right after a run's open tag */
const RUN_RPR_RE = /<w:rPr\b[^>]*?(?:\/>|>[\s\S]*?<\/w:rPr>)/y

function runRPr(xml: string, start: number): string | undefined {
  RUN_RPR_RE.lastIndex = xml.indexOf('>', start) + 1
  return RUN_RPR_RE.exec(xml)?.[0]
}

/**
 * The part's XML with every run hidden from AI replaced by a plain run that
 * holds its placeholder; runs next to each other under one label give one
 * placeholder, as a span in the body does. A hidden run holding other runs (a
 * text box in a drawing) is replaced whole. Reading the result's text gives
 * the part as a model may read it.
 */
export function withheldAsPlaceholders(xml: string): string {
  if (!xml.includes(`<${REDACT_EL}`)) return xml
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
