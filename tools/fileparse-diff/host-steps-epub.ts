// Host steps of epub-engine: what parse5 gives xml.ts, xml-positions.ts and text.ts. The gate answers
// them with the product's own steps (packages/file-parse/src/host-steps.ts), the ones the readers get in
// the app; the texts below are the lines of epub-engine those steps restate, and tools/epub-diff fails
// when epub-engine no longer holds them.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { repoRoot } from '../docx-diff/harness'
import { HOST_STEPS } from '../../packages/file-parse/src/host-steps'
import { EPUB_PURE_STEPS } from './host-steps-epub-pure'

/**
 * The lines of `resolveHtmlEntity` (packages/epub-engine/src/xml-positions.ts) that ask parse5, copied as they are:
 * the gate (xml-cases.ts) fails when that file no longer holds this text.
 */
export const SOURCE_FRAGMENT_TEXT = String.raw`    const fragment = parseFragment(ref)
    const node = fragment.childNodes[0] as { nodeName: string; value?: string } | undefined
    const decoded = node?.nodeName === '#text' ? node.value : undefined
`

/**
 * What `extractChapterText` (packages/epub-engine/src/text.ts) builds from parse5's tree, copied as it is: the type of
 * the nodes, `fromParse5` and the two lines that make `roots` of it. The gate (xml-cases.ts) fails when that file no
 * longer holds this text.
 */
export const SOURCE_PARSE5_ROOTS_TEXT = String.raw`interface Parse5Node {
  nodeName: string
  value?: string
  childNodes?: Parse5Node[]
  content?: Parse5Node
}

function fromParse5(node: Parse5Node): TextNode | null {
  if (node.nodeName === '#text') return { kind: 'text', value: node.value ?? '' }
  if (node.nodeName.startsWith('#')) return null
  return {
    kind: 'element',
    name: node.nodeName,
    children: (node.childNodes ?? []).map(fromParse5).filter((n): n is TextNode => n !== null),
  }
}
`

export const SOURCE_PARSE5_ROOTS_LINES = String.raw`    const doc = parse(source) as unknown as Parse5Node
    roots = (doc.childNodes ?? []).map(fromParse5).filter((n): n is TextNode => n !== null)
`

// the product's steps must still restate those lines
const product = readFileSync(resolve(repoRoot, 'packages/file-parse/src/host-steps.ts'), 'utf8')
for (const copy of [SOURCE_FRAGMENT_TEXT, SOURCE_PARSE5_ROOTS_TEXT, SOURCE_PARSE5_ROOTS_LINES]) {
  if (!product.includes(copy))
    throw new Error(
      'packages/file-parse/src/host-steps.ts no longer restates the parse5 lines of epub-engine',
    )
}

export const EPUB_STEPS: Record<string, (input: unknown) => unknown> = {
  ...EPUB_PURE_STEPS,
  'epub.parseHtml': HOST_STEPS['epub.parseHtml']!,
  'epub.parseFragmentText': HOST_STEPS['epub.parseFragmentText']!,
  'epub.chapterTextRoots': HOST_STEPS['epub.chapterTextRoots']!,
}
