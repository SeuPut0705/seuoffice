import { callEngine } from './engine'

/**
 * Book to plain text: every spine item's text in spine order, headings as `#`
 * lines, a blank line between chapters. Throws for a book that does not open:
 * refused by the zip gate, not an EPUB, or copy-protected. A chapter whose
 * bytes are not valid text is left out behind a marker, and a book with no
 * chapter that decodes is refused.
 */
export async function epubToText(bytes: Uint8Array): Promise<string> {
  return callEngine<string>('epubToText', [bytes])
}
