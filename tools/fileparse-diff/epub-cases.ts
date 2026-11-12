import { epubToText } from './reference/epub'
import { builtBooks } from '../epub-diff/epub-fixtures'
import { hostileZipInputs } from './hostile'
import type { Input, Spec } from './spec'

// epubToText runs the engine's openEpub, the zip gate before it, and extractChapterText for every chapter; a chapter that
// is not XML is read by parse5, the host's step `epub.chapterTextRoots`. The books come from epub-diff/epub-fixtures.ts:
// every refusal of openEpub (the gate's too-large and damaged, not-epub, drm), chapters whose bytes are not valid text,
// chapters that are XML and chapters that are not. No .epub file is tracked in this repository, so the corpus is empty.

async function built(): Promise<Input[]> {
  return [...(await builtBooks()).map(({ label, bytes }) => ({ label, bytes })), ...hostileZipInputs()]
}

export const SPECS: Spec[] = [
  {
    fn: 'epubToText',
    extensions: ['epub'],
    mutation: 'zip-xml',
    call: ({ bytes }) => epubToText(bytes!),
    built,
  },
]
