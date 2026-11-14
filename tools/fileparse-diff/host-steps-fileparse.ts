// Host steps of file-parse: the parse5 half of html-redaction and the draw.io readers. The gate answers
// them with the product's own steps (packages/file-parse/src/host-steps.ts), the ones the readers get in
// the app.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { repoRoot } from '../docx-diff/harness'
import { HOST_STEPS } from '../../packages/file-parse/src/host-steps'

/**
 * `sourceElements` of tools/fileparse-diff/reference/html-redaction.ts, copied as it
 * is: the gate (html-cases.ts) fails when that file no longer holds this text.
 */
export const SOURCE_ELEMENTS_TEXT = String.raw`function sourceElements(source: string): SourceElement[] {
  const doc = parse(source, { sourceCodeLocationInfo: true })
  const out: SourceElement[] = []
  const seen = new Set<number>()
  const stack: T.Node[] = [doc]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (isElement(node)) {
      const loc = node.sourceCodeLocation
      if (loc?.startTag && !seen.has(loc.startTag.startOffset)) {
        seen.add(loc.startTag.startOffset)
        const startTag: [number, number] = [loc.startTag.startOffset, loc.startTag.endOffset]
        const innerEnd = loc.endTag ? loc.endTag.startOffset : Math.max(startTag[1], loc.endOffset)
        out.push({ node, startTag, inner: [startTag[1], innerEnd] })
      }
    }
    const children: T.Node[] = 'childNodes' in node ? [...node.childNodes] : []
    if (isElement(node) && node.tagName === 'template') {
      const content = (node as T.Template).content
      if (content) children.push(...content.childNodes)
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!)
  }
  return out
}
`

// the product's step must still be that walk (html-cases.ts checks the reference holds it too)
if (
  !readFileSync(resolve(repoRoot, 'packages/file-parse/src/host-steps.ts'), 'utf8').includes(
    SOURCE_ELEMENTS_TEXT,
  )
) {
  throw new Error(
    'packages/file-parse/src/host-steps.ts no longer holds the sourceElements of html-redaction.ts',
  )
}

export const FILEPARSE_STEPS: Record<string, (input: unknown) => unknown> = {
  'fileparse.htmlSourceElements': HOST_STEPS['fileparse.htmlSourceElements']!,
  'fileparse.diagramFormatOf': HOST_STEPS['fileparse.diagramFormatOf']!,
  'fileparse.readDiagramText': HOST_STEPS['fileparse.readDiagramText']!,
  'fileparse.localOffsetSeconds': HOST_STEPS['fileparse.localOffsetSeconds']!,
}
