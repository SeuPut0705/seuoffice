import { buildDocx } from './build-docx'
import { OWN_REDACT_NS, PLACEHOLDER, SECRET } from './hidden-stories'

/**
 * A document for the ops that look for text (an anchor, a phrase to replace, a
 * paragraph to target): block 0 holds a hidden run between two plain ones,
 * block 1 is a heading holding one, block 2 a table whose second cell holds
 * one, block 3 a bookmarked paragraph that is hidden, block 4 a plain
 * paragraph with a plain bookmark.
 *
 * `literal`: the hidden words are the placeholder itself, `{{client phone}}`.
 */
export const HIDDEN_WORDS = (literal: boolean) => (literal ? PLACEHOLDER : SECRET)

const hiddenRun = (text: string) =>
  `<w:r><w:rPr><go:redact xmlns:go="${OWN_REDACT_NS}" w:label="client phone"/></w:rPr><w:t>${text}</w:t></w:r>`
const plainRun = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`

export function anchorsDocx(literal = false): Promise<Uint8Array> {
  const words = HIDDEN_WORDS(literal)
  return buildDocx({
    bodyXml:
      `<w:p>${plainRun('Call ')}${hiddenRun(words)}${plainRun(' now')}</w:p>` +
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${plainRun('Title ')}${hiddenRun(words)}</w:p>` +
      '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid><w:tr>' +
      `<w:tc><w:p>${plainRun('Name')}</w:p></w:tc><w:tc><w:p>${hiddenRun(words)}</w:p></w:tc></w:tr></w:tbl>` +
      `<w:p><w:bookmarkStart w:id="1" w:name="Secret"/>${hiddenRun(words)}<w:bookmarkEnd w:id="1"/>${plainRun(' tail')}</w:p>` +
      `<w:p><w:bookmarkStart w:id="2" w:name="Open"/>${plainRun('Open words')}<w:bookmarkEnd w:id="2"/></w:p>`,
  })
}

/** what an anchor can be: the hidden words, a part of them, a phrase reaching across the edge, or nothing there at all */
export function anchorsFor(literal = false): Record<string, string> {
  const words = HIDDEN_WORDS(literal)
  return {
    'the hidden words': words,
    'the start of them': words.slice(0, 4),
    'the end of them': words.slice(-4),
    'the middle of them': words.slice(2, 6),
    'across the left edge': `Call ${words.slice(0, 3)}`,
    'across the right edge': `${words.slice(-3)} now`,
    'across both edges': `Call ${words} now`,
    'a phrase that is not there': 'zzzz',
  }
}
