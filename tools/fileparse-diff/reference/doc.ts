import WordExtractor from 'word-extractor'
import { assertSoundCompoundFile } from './damaged-file'
import './vendor'

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim()
}

/** Extract readable body and text-box content from a legacy Word 97-2003 file. */
export async function docToText(bytes: Uint8Array): Promise<string> {
  // the extractor reads a file that starts like this with a compound-file reader of its own,
  // which follows a looping sector chain until memory runs out
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) assertSoundCompoundFile(bytes, 'Word 97-2003')
  const document = await new WordExtractor().extract(Buffer.from(bytes))
  const body = document.getBody({ filterUnicode: false })
  const textboxes = document.getTextboxes({
    filterUnicode: false,
    includeHeadersAndFooters: false,
  })
  return normalizeText([body, textboxes].filter((part) => part.trim()).join('\n'))
}
