/**
 * The position map over content.xml's body.
 *
 * `scanOdtBody` records, for `office:text`, every top-level child and the
 * structural elements nested inside it (paragraphs, lists, tables, rows,
 * cells, frames, text boxes, images, objects, shapes, bookmarks,
 * annotations, notes) as ranges into the ORIGINAL decoded string. Slicing the
 * string by a node's range returns that element's exact source. Inline markup
 * that is not structural (`text:span`, `text:s`, links, fields …) is not a
 * node; scan inside a paragraph's range with `XmlScanner` / `walkElements`.
 *
 * Hancom puts most tables inside `text:p > draw:frame > draw:text-box`, and
 * tables nest inside cells; both are just nested nodes here.
 */
import { OdtOpenError } from './errors'
import {
  type ElementFrame,
  type ElementRange,
  type PrefixMap,
  type XmlAttribute,
  attributeMap,
  readAttributes,
  readRoot,
  walkElements,
} from './xml'

export type OdtNodeKind =
  | 'paragraph' // text:p
  | 'heading' // text:h
  | 'list' // text:list
  | 'list-item' // text:list-item, text:list-header
  | 'section' // text:section
  | 'index' // text:table-of-content and the other text:*-index elements
  | 'table' // table:table
  | 'column-group' // table:table-columns, table:table-header-columns, table:table-column-group
  | 'table-column' // table:table-column
  | 'row-group' // table:table-header-rows, table:table-rows, table:table-row-group
  | 'table-row' // table:table-row
  | 'table-cell' // table:table-cell
  | 'covered-cell' // table:covered-table-cell (hidden by a merge)
  | 'frame' // draw:frame
  | 'text-box' // draw:text-box
  | 'image' // draw:image
  | 'object' // draw:object, draw:object-ole
  | 'shape' // draw:rect, draw:custom-shape, draw:g … and dr3d:scene
  | 'bookmark' // text:bookmark (a point)
  | 'bookmark-start' // text:bookmark-start
  | 'bookmark-end' // text:bookmark-end
  | 'annotation' // office:annotation
  | 'annotation-end' // office:annotation-end
  | 'note' // text:note (footnote / endnote)
  | 'other' // any other element directly under office:text
  | 'opaque' // a comment, CDATA, processing instruction or stray text directly under office:text

/** Canonical element name → node kind for the elements recorded at any depth. */
export const ODT_NODE_KINDS: Readonly<Record<string, OdtNodeKind>> = {
  'text:p': 'paragraph',
  'text:h': 'heading',
  'text:list': 'list',
  'text:list-item': 'list-item',
  'text:list-header': 'list-item',
  'text:section': 'section',
  'text:table-of-content': 'index',
  'text:illustration-index': 'index',
  'text:table-index': 'index',
  'text:object-index': 'index',
  'text:user-index': 'index',
  'text:alphabetical-index': 'index',
  'text:bibliography': 'index',
  'table:table': 'table',
  'table:table-columns': 'column-group',
  'table:table-header-columns': 'column-group',
  'table:table-column-group': 'column-group',
  'table:table-column': 'table-column',
  'table:table-header-rows': 'row-group',
  'table:table-rows': 'row-group',
  'table:table-row-group': 'row-group',
  'table:table-row': 'table-row',
  'table:table-cell': 'table-cell',
  'table:covered-table-cell': 'covered-cell',
  'draw:frame': 'frame',
  'draw:text-box': 'text-box',
  'draw:image': 'image',
  'draw:object': 'object',
  'draw:object-ole': 'object',
  'draw:rect': 'shape',
  'draw:line': 'shape',
  'draw:polyline': 'shape',
  'draw:polygon': 'shape',
  'draw:regular-polygon': 'shape',
  'draw:path': 'shape',
  'draw:circle': 'shape',
  'draw:ellipse': 'shape',
  'draw:g': 'shape',
  'draw:page-thumbnail': 'shape',
  'draw:connector': 'shape',
  'draw:caption': 'shape',
  'draw:measure': 'shape',
  'draw:control': 'shape',
  'draw:custom-shape': 'shape',
  'dr3d:scene': 'shape',
  'text:bookmark': 'bookmark',
  'text:bookmark-start': 'bookmark-start',
  'text:bookmark-end': 'bookmark-end',
  'office:annotation': 'annotation',
  'office:annotation-end': 'annotation-end',
  'text:note': 'note',
}

/** Shared by the nodes of one scan: the source string and its prefix map. */
interface NodeSource {
  readonly xml: string
  readonly prefixes: PrefixMap
}

/**
 * One recorded element (or opaque top-level item). Offsets index the decoded
 * content.xml string. Attributes are parsed lazily on first use.
 */
export class OdtNode implements ElementRange {
  /** the parent node (nearest recorded ancestor); `null` for top-level blocks */
  parent: OdtNode | null = null
  /** recorded descendants whose nearest recorded ancestor is this node, in document order */
  readonly children: OdtNode[] = []
  closeStart: number
  end: number
  private attrCache: Record<string, string> | undefined

  constructor(
    private readonly source: NodeSource,
    readonly kind: OdtNodeKind,
    /** canonical qualified name (`text:p`), or `#comment` / `#cdata` / `#pi` / `#text` / `#doctype` */
    readonly name: string,
    /** qualified name as written in the file */
    readonly tag: string,
    readonly start: number,
    /** one past the start tag's `>` (equals `end` for self-closing and opaque nodes) */
    readonly openEnd: number,
    /** one past the element name inside the start tag */
    readonly nameEnd: number,
    readonly selfClosing: boolean,
  ) {
    this.closeStart = openEnd
    this.end = openEnd
  }

  /** Decoded attribute values keyed by canonical name. */
  get attrs(): Readonly<Record<string, string>> {
    if (!this.attrCache) {
      this.attrCache =
        this.kind === 'opaque'
          ? {}
          : attributeMap(this.source.xml, this.nameEnd, this.openEnd, this.source.prefixes)
    }
    return this.attrCache
  }

  /** A decoded attribute value by canonical name. */
  attr(name: string): string | undefined {
    return this.attrs[name]
  }

  /** The still-escaped attribute value exactly as written, by canonical name. */
  attrRaw(name: string): string | undefined {
    return this.attributes().find((a) => this.source.prefixes.canonical(a.name) === name)?.raw
  }

  /** The start tag's attributes with their source offsets (for narrow patching). */
  attributes(): XmlAttribute[] {
    if (this.kind === 'opaque') return []
    return readAttributes(this.source.xml, this.nameEnd, this.openEnd)
  }
}

export interface OdtBody {
  /** the decoded content.xml string every offset refers to */
  readonly xml: string
  /** the `office:text` element itself */
  readonly text: ElementRange
  /** direct children of `office:text`, in order */
  readonly blocks: OdtNode[]
  /** tolerated malformed markup (unclosed or stray tags) */
  readonly warnings: string[]
  /** namespace prefixes of the part (canonical name lookup) */
  readonly prefixes: PrefixMap
}

const OPAQUE_NAMES: Partial<Record<string, string>> = {
  comment: '#comment',
  cdata: '#cdata',
  pi: '#pi',
  doctype: '#doctype',
  text: '#text',
}

/**
 * Builds the position map of content.xml's `office:text`. Throws
 * `OdtOpenError('corrupt')` when there is no `office:text`.
 */
export function scanOdtBody(xml: string): OdtBody {
  const root = readRoot(xml)
  if (!root) throw new OdtOpenError('corrupt', 'odt: content.xml has no root element')
  const prefixes = root.prefixes
  const source: NodeSource = { xml, prefixes }
  const blocks: OdtNode[] = []
  const warnings: string[] = []
  let textFrame: ElementFrame | null = null

  const makeNode = (kind: OdtNodeKind, el: ElementFrame): OdtNode =>
    new OdtNode(source, kind, el.name, el.tag, el.start, el.openEnd, el.nameEnd, el.selfClosing)

  walkElements(xml, prefixes, {
    open(el, parent) {
      if (!textFrame) {
        if (el.name === 'office:text') {
          textFrame = el
          return
        }
        // nothing outside the body is recorded here
        return el.name === 'office:automatic-styles' || el.name === 'office:font-face-decls'
          ? 'skip'
          : undefined
      }
      const owner = parent === textFrame ? null : (parent?.data as OdtNode | null | undefined)
      let kind = ODT_NODE_KINDS[el.name]
      if (!kind && parent === textFrame) kind = 'other'
      if (!kind) {
        el.data = owner ?? null
        return
      }
      const node = makeNode(kind, el)
      if (owner) {
        node.parent = owner
        owner.children.push(node)
      } else {
        blocks.push(node)
      }
      el.data = node
    },
    close(el) {
      if (el === textFrame) return 'stop'
      const node = el.data as OdtNode | null | undefined
      if (node && node.start === el.start) {
        node.closeStart = el.closeStart
        node.end = el.end
      }
    },
    other(kind, start, end, parent) {
      if (!textFrame || parent !== textFrame) return
      if (kind === 'text' && xml.slice(start, end).trim() === '') return
      const name = OPAQUE_NAMES[kind] ?? `#${kind}`
      const node = new OdtNode(source, 'opaque', name, name, start, end, start, false)
      blocks.push(node)
    },
    warn(message) {
      warnings.push(message)
    },
  })

  const text = textFrame as ElementFrame | null
  if (!text) throw new OdtOpenError('corrupt', 'odt: content.xml has no office:text')
  return {
    xml,
    text: {
      start: text.start,
      openEnd: text.openEnd,
      closeStart: text.closeStart < 0 ? xml.length : text.closeStart,
      end: text.end < 0 ? xml.length : text.end,
      selfClosing: text.selfClosing,
    },
    blocks,
    warnings,
    prefixes,
  }
}

/** The exact source text of a node. */
export function sliceNode(source: { readonly xml: string } | string, node: ElementRange): string {
  return (typeof source === 'string' ? source : source.xml).slice(node.start, node.end)
}

/**
 * Visits nodes depth first in document order. Return `false` from `visit` to
 * skip a node's children.
 */
export function walkNodes(
  nodes: readonly OdtNode[],
  visit: (node: OdtNode) => void | boolean,
): void {
  const stack: OdtNode[] = [...nodes].reverse()
  while (stack.length) {
    const node = stack.pop() as OdtNode
    if (visit(node) === false) continue
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i])
  }
}

/** Every node of `kind` at any depth, in document order. */
export function nodesOfKind(nodes: readonly OdtNode[], kind: OdtNodeKind): OdtNode[] {
  const out: OdtNode[] = []
  walkNodes(nodes, (node) => {
    if (node.kind === kind) out.push(node)
  })
  return out
}

/** `text:anchor-type` of a frame or shape (`as-char`, `paragraph`, `char`, `page`, `frame`), or null. */
export function anchorType(node: OdtNode): string | null {
  return node.attr('text:anchor-type') ?? null
}

/** Column and row span of a cell; 1 when the attribute is missing or invalid. */
export function cellSpan(node: OdtNode): { columns: number; rows: number } {
  const span = (value: string | undefined) => {
    const n = value === undefined ? NaN : parseInt(value, 10)
    return Number.isFinite(n) && n > 0 ? n : 1
  }
  return {
    columns: span(node.attr('table:number-columns-spanned')),
    rows: span(node.attr('table:number-rows-spanned')),
  }
}

/** The decoded `text:name` of a bookmark node (Hancom `NormalField…` names kept as written). */
export function bookmarkName(node: OdtNode): string | null {
  return node.attr('text:name') ?? null
}

export interface BookmarkPair {
  /** decoded bookmark name */
  name: string
  /** `text:bookmark-start`, or null for a point bookmark or an end without a start */
  start: OdtNode | null
  /** the matching `text:bookmark-end`, or null when the file never closes it */
  end: OdtNode | null
  /** a single `text:bookmark` (point) */
  point: OdtNode | null
}

/**
 * Pairs bookmark starts and ends by name in document order. Real Hancom files
 * contain starts without ends; those come back with `end: null`.
 */
export function pairBookmarks(body: Pick<OdtBody, 'blocks'>): BookmarkPair[] {
  const out: BookmarkPair[] = []
  const open = new Map<string, BookmarkPair[]>()
  walkNodes(body.blocks, (node) => {
    if (node.kind !== 'bookmark' && node.kind !== 'bookmark-start' && node.kind !== 'bookmark-end')
      return
    const name = bookmarkName(node) ?? ''
    if (node.kind === 'bookmark') {
      out.push({ name, start: null, end: null, point: node })
    } else if (node.kind === 'bookmark-start') {
      const pair: BookmarkPair = { name, start: node, end: null, point: null }
      out.push(pair)
      const list = open.get(name)
      if (list) list.push(pair)
      else open.set(name, [pair])
    } else {
      const pair = open.get(name)?.pop()
      if (pair) pair.end = node
      else out.push({ name, start: null, end: node, point: null })
    }
  })
  return out
}

export interface AnnotationPair {
  /** decoded `office:name`, or null for an annotation without a range */
  name: string | null
  annotation: OdtNode
  /** the matching `office:annotation-end`, if any */
  end: OdtNode | null
}

/** Pairs each `office:annotation` with its `office:annotation-end` by `office:name`. */
export function pairAnnotations(body: Pick<OdtBody, 'blocks'>): AnnotationPair[] {
  const out: AnnotationPair[] = []
  const open = new Map<string, AnnotationPair>()
  walkNodes(body.blocks, (node) => {
    if (node.kind === 'annotation') {
      const name = node.attr('office:name') ?? null
      const pair: AnnotationPair = { name, annotation: node, end: null }
      out.push(pair)
      if (name !== null) open.set(name, pair)
      // an annotation's own paragraphs never contain its end marker
      return false
    }
    if (node.kind === 'annotation-end') {
      const name = node.attr('office:name')
      const pair = name === undefined ? undefined : open.get(name)
      if (pair && !pair.end) pair.end = node
    }
  })
  return out
}
