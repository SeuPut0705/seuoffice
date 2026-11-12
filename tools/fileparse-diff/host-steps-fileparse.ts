// Host steps of file-parse: PDF text, the parse5 half of html-redaction, and
// the readers of the engines not ported (odt, xmind, draw.io, EPUB opening).
import { parse, type DefaultTreeAdapterTypes as T } from 'parse5'
import { diagramFormatOf, readDiagramText } from '../../packages/file-parse/src/diagram'

interface SourceElement {
  node: T.Element
  startTag: [number, number]
  inner: [number, number]
}

function isElement(node: T.Node): node is T.Element {
  return 'tagName' in node && typeof (node as T.Element).tagName === 'string'
}

/**
 * `sourceElements` of packages/file-parse/src/html-redaction.ts, copied as it
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

function sourceElements(source: string): SourceElement[] {
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

/** A string field of a step's JSON input; a step given another shape throws. */
export function stringField(input: unknown, key: string): string {
  const value = input !== null && typeof input === 'object' && key in input ? (input as Record<string, unknown>)[key] : undefined
  if (typeof value !== 'string') throw new TypeError(`host step input has no string ${key}`)
  return value
}

export const FILEPARSE_STEPS: Record<string, (input: unknown) => unknown> = {
  /** the elements sourceElements lists, as crates/file-parse/src/html.rs reads them */
  'fileparse.htmlSourceElements': (input) => sourceElements(stringField(input, 'source')).map(e => ({
    tagName: e.node.tagName,
    attrs: e.node.attrs.map(attr => ({ name: attr.name, value: attr.value })),
    startTag: e.startTag,
    inner: e.inner,
  })),
  /** diagramFormatOf of packages/file-parse/src/diagram.ts */
  'fileparse.diagramFormatOf': (input) => diagramFormatOf(stringField(input, 'filePath')),
  /** readDiagramText: the read, or the failure with its reason */
  'fileparse.readDiagramText': (input) => {
    const bytes = new Uint8Array(Buffer.from(stringField(input, 'bytesBase64'), 'base64'))
    return readDiagramText(stringField(input, 'fileName'), bytes)
  },
}
