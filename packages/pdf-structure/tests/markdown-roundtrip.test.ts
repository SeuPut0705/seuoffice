// @vitest-environment jsdom
/**
 * Spec §3 check: a converted file opened in our Markdown editor and saved
 * again keeps every block the user did not edit byte for byte. Runs the
 * editor's own block split and splice (apps/markdown sourceSplice.ts) over
 * the editor's real extension set, and reads the parse back to confirm each
 * format rule means what it says in the editor.
 *
 * The editor modules are loaded by runtime path: they are typed against the
 * DOM and JSX, which this package's typecheck does not include.
 */
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import * as editorMath from '../../../apps/markdown/src/renderer/editor/mathSyntax'
import { treeToMarkdown } from '../src/markdown'
import { containsMathSyntax, matchInlineMath } from '../src/markdown/syntax'
import { sha256Hex } from '../src/tree'
import type {
  CaptionBlock,
  DocumentTree,
  InlineRun,
  ParagraphBlock,
  TableCell,
  TextRun,
  TreeBlock,
} from '../src/tree'

// ── minimal views of the editor modules ──

interface PmNode {
  childCount: number
  child(index: number): PmNode
  nodeSize: number
}
interface EditorLike {
  state: { doc: PmNode }
  commands: {
    setContent(content: string, options: { contentType: 'markdown' }): boolean
    insertContentAt(pos: number, content: string): boolean
  }
  getJSON(): JsonNode
  destroy(): void
}
interface JsonNode {
  type: string
  attrs?: Record<string, unknown>
  text?: string
  marks?: { type: string; attrs?: Record<string, unknown> }[]
  content?: JsonNode[]
}
interface SpliceModule {
  buildSourceMap(editor: EditorLike, doc: PmNode, source: string): unknown
  spliceMarkdown(editor: EditorLike, doc: PmNode, map: unknown): string
}

const editorSrc = join(__dirname, '../../../apps/markdown/src/renderer')
let splice: SpliceModule
let editor: EditorLike

beforeAll(async () => {
  const { Editor } = (await import('@tiptap/core')) as unknown as {
    Editor: new (options: unknown) => EditorLike
  }
  const extensionsPath = join(editorSrc, 'editor/extensions.ts')
  const splicePath = join(editorSrc, 'markdown/sourceSplice.ts')
  const { buildExtensions } = (await import(/* @vite-ignore */ extensionsPath)) as {
    buildExtensions(options: unknown): unknown[]
  }
  splice = (await import(/* @vite-ignore */ splicePath)) as SpliceModule
  editor = new Editor({
    extensions: buildExtensions({
      slashController: {
        onOpen: () => {},
        onUpdate: () => {},
        onKeyDown: () => false,
        onClose: () => {},
      },
      slashItems: () => [],
    }),
    content: '',
  })
  return () => editor.destroy()
}, 120_000)

function load(source: string): unknown {
  editor.commands.setContent(source, { contentType: 'markdown' })
  return splice.buildSourceMap(editor, editor.state.doc, source)
}

// ── a tree exercising every format rule ──

let seq = 0
const at = () => ({ id: `p1.${++seq}`, page: 1, pageFingerprint: 'fp1', source: 'pdf' as const })
const tx = (text: string, marks: Omit<TextRun, 'kind' | 'text'> = {}): TextRun => ({
  kind: 'text',
  text,
  ...marks,
})
const br: InlineRun = { kind: 'lineBreak' }
const para = (...runs: InlineRun[]): TreeBlock => ({ ...at(), kind: 'paragraph', runs })
const notePara = (text: string): ParagraphBlock => ({
  ...at(),
  kind: 'paragraph',
  runs: [tx(text)],
})
const item = (ordered: boolean, level: number, text: string): TreeBlock => ({
  ...at(),
  kind: 'listItem',
  ordered,
  level,
  runs: [tx(text)],
})
const caption = (text: string): CaptionBlock => ({
  ...at(),
  kind: 'caption',
  position: 'below',
  runs: [tx(text)],
})
const cell = (row: number, col: number, paragraphs: InlineRun[][], span = 1): TableCell => ({
  row,
  col,
  rowSpan: 1,
  colSpan: span,
  paragraphs,
})
const png = new Uint8Array([137, 80, 78, 71, 1])
const scan = new Uint8Array([137, 80, 78, 71, 2])

function richTree(): DocumentTree {
  const blocks: TreeBlock[] = [
    { ...at(), kind: 'pageBreak' },
    { ...at(), kind: 'heading', level: 1, levelSource: 'bookmark', runs: [tx('Title')] },
    { ...at(), kind: 'heading', level: 3, levelSource: 'font', runs: [tx('Learn C #')] },
    para(tx('plain words')),
    para(
      tx('Mixed '),
      tx('bold', { bold: true }),
      tx(' and '),
      tx('it', { italic: true }),
      tx(' and '),
      tx('link', { href: 'https://example.com/a b' }),
      tx(' and '),
      tx('Note:', { bold: true }),
      tx('text'),
    ),
    para(tx('<b>x</b> R&D &amp; a > b [1] snake_case')),
    para(tx('costs $5 and '), { kind: 'math', latex: 'x' }, tx('2 then '), {
      kind: 'math',
      latex: '\\pi r^2',
    }),
    para(tx('first'), br, tx('# second'), { kind: 'footnoteRef', id: 'n1' }, tx('(paren)')),
    item(false, 0, 'bullet'),
    item(false, 1, 'nested'),
    item(true, 2, 'deep ordered'),
    item(false, 0, 'back out'),
    item(true, 0, 'ordered'),
    item(true, 0, 'second'),
    {
      ...at(),
      kind: 'table',
      table: {
        rowCount: 2,
        colCount: 3,
        cells: [
          cell(0, 0, [[tx('wide')]], 2),
          cell(0, 2, [[tx('a|b')]]),
          cell(1, 0, [[tx('one')], [tx('two')]]),
          cell(1, 1, [[{ kind: 'math', latex: 'y' }]]),
          cell(1, 2, [[tx('z')]]),
        ],
      },
      caption: caption('Table 1. Data'),
    },
    {
      ...at(),
      kind: 'image',
      data: png,
      mime: 'image/png',
      pixelWidth: 1,
      pixelHeight: 1,
      widthPt: 1,
      heightPt: 1,
      caption: caption('Figure 1: A picture'),
    },
    { ...at(), kind: 'math', latex: 'E = mc^2' },
    { ...at(), kind: 'pageBreak', page: 2 },
    {
      ...at(),
      kind: 'pageImage',
      page: 2,
      reason: 'degraded',
      data: scan,
      mime: 'image/png',
      pixelWidth: 1,
      pixelHeight: 1,
      widthPt: 1,
      heightPt: 1,
    },
    para(tx('again'), { kind: 'footnoteRef', id: 'n2' }),
  ]
  return {
    version: 1,
    variant: 'original',
    info: {},
    sourcePageCount: 2,
    pages: [],
    blocks,
    footnotes: [
      { id: 'n1', page: 1, pageFingerprint: 'fp1', blocks: [notePara('Short note.')] },
      {
        id: 'n2',
        page: 1,
        pageFingerprint: 'fp1',
        blocks: [notePara('A longer note.'), notePara('Second paragraph.')],
      },
    ],
    outline: [],
    toc: [],
    footnoteLinkFailedPages: [],
    warnings: [],
  }
}

// ── reading the parse back ──

function find(node: JsonNode, type: string): JsonNode[] {
  const out: JsonNode[] = node.type === type ? [node] : []
  for (const child of node.content ?? []) out.push(...find(child, type))
  return out
}
const textOf = (node: JsonNode): string =>
  node.type === 'text'
    ? (node.text ?? '')
    : node.type === 'hardBreak'
      ? '\n'
      : node.type === 'inlineMath'
        ? `$${String(node.attrs?.latex)}$`
        : // the editor reads `[^1]` as a footnote reference node since it learned footnotes
          node.type === 'footnoteReference'
          ? `[^${String(node.attrs?.label)}]`
          : (node.content ?? []).map(textOf).join('')
const marksOf = (doc: JsonNode, text: string): string[] =>
  (find(doc, 'text').find((n) => n.text === text)?.marks ?? []).map((m) => m.type)

describe('round trip through the Markdown editor', () => {
  const md = treeToMarkdown(richTree()).markdown

  it('saves an unedited converted file byte for byte', () => {
    const map = load(md)
    expect(map).not.toBeNull()
    expect(splice.spliceMarkdown(editor, editor.state.doc, map)).toBe(md)
  })

  it('re-serializes only the edited block', () => {
    const map = load(md)
    const doc = editor.state.doc
    // top-level node 2 is the "plain words" paragraph (after two headings)
    let pos = 0
    for (let k = 0; k < 2; k++) pos += doc.child(k).nodeSize
    editor.commands.insertContentAt(pos + doc.child(2).nodeSize - 1, ' more')
    const out = splice.spliceMarkdown(editor, editor.state.doc, map)
    expect(out).toBe(md.replace('plain words\n', 'plain words more\n'))
  })

  it('reads every format rule back as intended', () => {
    load(md)
    const doc = editor.getJSON()
    expect(find(doc, 'heading').map((h) => [h.attrs?.level, textOf(h)])).toEqual([
      [1, 'Title'],
      [3, 'Learn C #'],
    ])
    expect(marksOf(doc, 'bold')).toEqual(['bold'])
    expect(marksOf(doc, 'it')).toEqual(['italic'])
    const link = find(doc, 'text').find((n) => n.text === 'link')!
    expect(link.marks?.[0]?.attrs?.href).toBe('https://example.com/a%20b')
    expect(marksOf(doc, 'Note')).toEqual(['bold'])
    const paragraphs = find(doc, 'paragraph').map(textOf)
    expect(paragraphs).toContain('Mixed bold and it and link and Note:text')
    expect(paragraphs).toContain('<b>x</b> R&D &amp; a > b [1] snake_case')
    expect(paragraphs).toContain('costs $5 and $x$2 then $\\pi r^2$')
    expect(paragraphs).toContain('first\n# second[^1](paren)')
    // lists: bullet > bullet > ordered, then an ordered list of two
    const lists = (doc.content ?? []).filter((n) => /List$/.test(n.type)).map((n) => n.type)
    expect(lists.map((t) => t.replace(/^loose/i, '').toLowerCase())).toEqual([
      'bulletlist',
      'orderedlist',
    ])
    expect(find(doc, 'listItem').map((n) => textOf(n.content![0]!))).toEqual([
      'bullet',
      'nested',
      'deep ordered',
      'back out',
      'ordered',
      'second',
    ])
    // table: header row, merged cell un-merged, <br> back to a break, escaped pipe
    const [table] = find(doc, 'table')
    const rows = (table!.content ?? []).map((row) => (row.content ?? []).map(textOf))
    expect(rows).toEqual([
      ['wide', '', 'a|b'],
      ['one\ntwo', '$y$', 'z'],
    ])
    const images = find(doc, 'image').map((n) => n.attrs?.src)
    expect(images).toEqual([`assets/${sha256Hex(png)}.png`, `assets/${sha256Hex(scan)}.png`])
    expect(marksOf(doc, 'Figure 1: A picture')).toEqual(['italic'])
    expect(marksOf(doc, 'Table 1. Data')).toEqual(['italic'])
    expect(find(doc, 'blockMath').map((n) => n.attrs?.latex)).toEqual(['E = mc^2'])
    // nothing about the degraded page in the body
    expect(md).not.toMatch(/page 2/)
  })
})

describe('formula syntax mirror', () => {
  const samples = [
    '$x$',
    '$x$2',
    '$ x$',
    '$x $',
    '$5 and 10$',
    '$2 + 3$',
    '$a\\$',
    '$x$$',
    'costs \\$5 and $x$',
    'costs $5 and $10',
    'a $b$ c',
    '$$x$$',
    '\\$x\\$',
    'none',
  ]

  it('agrees with the editor on every sample', () => {
    for (const s of samples) {
      expect([s, containsMathSyntax(s)]).toEqual([s, editorMath.containsMathSyntax(s)])
      expect([s, matchInlineMath(s)]).toEqual([s, editorMath.matchInlineMath(s)])
    }
  })
})
