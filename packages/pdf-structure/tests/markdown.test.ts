/** Markdown writer: spec §3 format rules, each with a matching and an adjacent case. */
import { describe, expect, it } from 'vitest'
import { treeToMarkdown } from '../src/markdown'
import type { MarkdownConversion } from '../src/markdown'
import { deriveBilingualTree, deriveTranslatedTree, sha256Hex } from '../src/tree'
import type {
  CaptionBlock,
  DocumentTree,
  FootnoteDef,
  InlineRun,
  PageInfo,
  TableCell,
  TextRun,
  TreeBlock,
} from '../src/tree'

let seq = 0
const at = (page = 1) => ({
  id: `p${page}.${++seq}`,
  page,
  pageFingerprint: `fp${page}`,
  source: 'pdf' as const,
})

const tx = (text: string, marks: Omit<TextRun, 'kind' | 'text'> = {}): TextRun => ({
  kind: 'text',
  text,
  ...marks,
})
const b = (text: string): TextRun => tx(text, { bold: true })
const i = (text: string): TextRun => tx(text, { italic: true })
const link = (text: string, href: string, marks: Omit<TextRun, 'kind' | 'text' | 'href'> = {}) =>
  tx(text, { href, ...marks })
const fn = (id: string): InlineRun => ({ kind: 'footnoteRef', id })
const m = (latex: string): InlineRun => ({ kind: 'math', latex })
const br: InlineRun = { kind: 'lineBreak' }
const runs = (xs: (InlineRun | string)[]): InlineRun[] =>
  xs.map((x) => (typeof x === 'string' ? tx(x) : x))

const para = (...xs: (InlineRun | string)[]): TreeBlock => ({
  ...at(),
  kind: 'paragraph',
  runs: runs(xs),
})
const heading = (level: 1 | 2 | 3 | 4 | 5 | 6, ...xs: (InlineRun | string)[]): TreeBlock => ({
  ...at(),
  kind: 'heading',
  level,
  levelSource: 'font',
  runs: runs(xs),
})
const item = (
  ordered: boolean,
  level: number,
  text: string | InlineRun[],
  marker?: string,
): TreeBlock => ({
  ...at(),
  kind: 'listItem',
  ordered,
  level,
  ...(marker ? { marker } : {}),
  runs: typeof text === 'string' ? [tx(text)] : text,
})
const caption = (...xs: (InlineRun | string)[]): CaptionBlock => ({
  ...at(),
  kind: 'caption',
  position: 'below',
  runs: runs(xs),
})
const cell = (
  row: number,
  col: number,
  text: string | InlineRun[][],
  span: { rowSpan?: number; colSpan?: number } = {},
): TableCell => ({
  row,
  col,
  rowSpan: span.rowSpan ?? 1,
  colSpan: span.colSpan ?? 1,
  paragraphs: typeof text === 'string' ? [[tx(text)]] : text,
})
const table = (
  rowCount: number,
  colCount: number,
  cells: TableCell[],
  cap?: CaptionBlock,
): TreeBlock => ({
  ...at(),
  kind: 'table',
  table: { rowCount, colCount, cells },
  ...(cap ? { caption: cap } : {}),
})
const bytes = (...xs: number[]) => new Uint8Array(xs)
const image = (
  data: Uint8Array,
  extra: { mime?: 'image/png' | 'image/jpeg'; caption?: CaptionBlock; placeholder?: true } = {},
): TreeBlock => ({
  ...at(),
  kind: 'image',
  data,
  mime: extra.mime ?? 'image/png',
  pixelWidth: 10,
  pixelHeight: 10,
  widthPt: 10,
  heightPt: 10,
  ...(extra.caption ? { caption: extra.caption } : {}),
  ...(extra.placeholder ? { placeholder: true as const } : {}),
})
const pageImage = (page: number, reason: 'scanned' | 'degraded', data: Uint8Array): TreeBlock => ({
  ...at(page),
  kind: 'pageImage',
  reason,
  data,
  mime: 'image/png',
  pixelWidth: 10,
  pixelHeight: 10,
  widthPt: 10,
  heightPt: 10,
})
const pageBreak = (page: number): TreeBlock => ({ ...at(page), kind: 'pageBreak' })
const mathBlock = (latex: string): TreeBlock => ({ ...at(), kind: 'math', latex })
const note = (id: string, ...paragraphs: (InlineRun | string)[][]): FootnoteDef => ({
  id,
  page: 1,
  pageFingerprint: 'fp1',
  blocks: paragraphs.map((p) => ({ ...at(), kind: 'paragraph', runs: runs(p) })),
})

const pageInfo = (page: number, status: PageInfo['status'] = 'text'): PageInfo => ({
  page,
  fingerprint: `fp${page}`,
  status,
  widthPt: 612,
  heightPt: 792,
})

function tree(
  blocks: TreeBlock[],
  extra: Partial<Omit<DocumentTree, 'blocks'>> = {},
): DocumentTree {
  return {
    version: 1,
    variant: 'original',
    info: {},
    sourcePageCount: 1,
    pages: [pageInfo(1)],
    footnotes: [],
    outline: [],
    toc: [],
    footnoteLinkFailedPages: [],
    warnings: [],
    ...extra,
    blocks,
  }
}

const md = (blocks: TreeBlock[], extra?: Partial<Omit<DocumentTree, 'blocks'>>): string =>
  treeToMarkdown(tree(blocks, extra)).markdown

describe('headings', () => {
  it('writes levels 1–6 as # … ######', () => {
    const out = md([1, 2, 3, 4, 5, 6].map((l) => heading(l as 1, `H${l}`)))
    expect(out).toBe('# H1\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6\n')
  })

  it('keeps a trailing # that would read as a closing sequence, and folds line breaks', () => {
    expect(md([heading(2, 'Learn C #')])).toBe('## Learn C \\#\n')
    expect(md([heading(1, 'C#')])).toBe('# C#\n')
    expect(md([heading(1, 'A', br, 'B')])).toBe('# A B\n')
  })

  it('drops bold from a heading set wholly in bold, keeps it on a bold part', () => {
    expect(md([heading(1, b('Morning garden'))])).toBe('# Morning garden\n')
    expect(md([heading(2, b('Part'), ' one')])).toBe('## **Part** one\n')
  })

  it('drops an empty heading', () => {
    expect(md([heading(1, '  '), para('x')])).toBe('x\n')
  })

  it('escapes a paragraph that would read as a heading', () => {
    expect(md([para('# not a heading')])).toBe('\\# not a heading\n')
  })
})

describe('paragraphs and hard breaks', () => {
  it('separates blocks with one blank line and ends with a newline', () => {
    expect(md([para('a'), para('b')])).toBe('a\n\nb\n')
    expect(md([])).toBe('')
  })

  it('writes a line break as a hard break and escapes the next line start', () => {
    expect(md([para('one', br, 'two')])).toBe('one  \ntwo\n')
    expect(md([para('one', br, '- two', br, '2. three')])).toBe('one  \n\\- two  \n2\\. three\n')
  })

  it('trims edge whitespace so text never becomes indented code', () => {
    expect(md([para('      code?  ')])).toBe('code?\n')
  })

  it('page breaks write nothing', () => {
    expect(md([pageBreak(1), para('a'), pageBreak(2), para('b')])).toBe('a\n\nb\n')
  })
})

describe('lists', () => {
  it('writes bullets with nesting', () => {
    expect(md([item(false, 0, 'a'), item(false, 1, 'b'), item(false, 0, 'c')])).toBe(
      '- a\n  - b\n- c\n',
    )
  })

  it('numbers ordered items and nests under the content column', () => {
    expect(
      md([item(true, 0, 'a'), item(true, 1, 'b'), item(true, 1, 'c'), item(true, 0, 'd')]),
    ).toBe('1. a\n   1. b\n   2. c\n2. d\n')
    expect(md([item(false, 0, 'a'), item(true, 1, 'b')])).toBe('- a\n  1. b\n')
  })

  it('clamps a level jump to one deeper', () => {
    expect(md([item(false, 0, 'a'), item(false, 2, 'b')])).toBe('- a\n  - b\n')
    expect(md([item(false, 3, 'a')])).toBe('- a\n')
  })

  it('continues numbering across a page break, restarts after a paragraph', () => {
    expect(md([item(true, 0, 'a'), pageBreak(2), item(true, 0, 'b')])).toBe('1. a\n2. b\n')
    expect(md([item(true, 0, 'a'), para('p'), item(true, 0, 'b')])).toBe('1. a\n\np\n\n1. b\n')
  })

  it('starts an ordered list at the printed number', () => {
    expect(md([item(true, 0, 'x', '3.'), item(true, 0, 'y', '4.')])).toBe('3. x\n4. y\n')
    expect(md([item(true, 0, 'x', '(a)')])).toBe('1. x\n')
  })

  it('separates a bullet list from a following ordered list', () => {
    expect(md([item(false, 0, 'a'), item(true, 0, 'b')])).toBe('- a\n\n1. b\n')
  })

  it('escapes item text that would read as a nested marker or a task box', () => {
    expect(md([item(false, 0, '- dash')])).toBe('- \\- dash\n')
    expect(md([item(false, 0, '[ ] box')])).toBe('- \\[ \\] box\n')
  })

  it('indents a hard-broken continuation line to the content column', () => {
    expect(md([item(true, 0, [tx('a'), br, tx('b')])])).toBe('1. a  \n   b\n')
  })

  it('does not treat a paragraph starting with a number as a list', () => {
    expect(md([para('1. not a list')])).toBe('1\\. not a list\n')
  })
})

describe('inline marks', () => {
  it('keeps bold, italic and both', () => {
    expect(
      md([para('a ', b('bold'), ' ', i('it'), ' ', tx('both', { bold: true, italic: true }))]),
    ).toBe(
      // the space between two italic runs stays inside the italic
      'a **bold** *it **both***\n',
    )
  })

  it('moves edge whitespace outside the delimiters', () => {
    expect(md([para('a', b(' b '), 'c')])).toBe('a **b** c\n')
    expect(md([para('a', b('   '), 'c')])).toBe('a   c\n')
  })

  it('merges adjacent runs with the same marks', () => {
    expect(md([para(b('one '), b('two'))])).toBe('**one two**\n')
  })

  it('nests overlapping marks instead of interleaving them', () => {
    expect(md([para(b('a '), tx('b', { bold: true, italic: true }), b(' c'))])).toBe(
      '**a *b* c**\n',
    )
  })

  it('moves edge punctuation out when a word follows directly', () => {
    expect(md([para(b('Note:'), 'text')])).toBe('**Note**:text\n')
    expect(md([para(b('Note:'), ' text')])).toBe('**Note:** text\n')
    expect(md([para('x', b('(y)'))])).toBe('x(**y)**\n')
  })

  it('escapes Markdown syntax in text', () => {
    expect(md([para('a*b_c `d` ~e~ \\f')])).toBe('a\\*b\\_c \\`d\\` \\~e\\~ \\\\f\n')
    expect(md([para('<b>x</b> R&D &amp; a > b')])).toBe('&lt;b>x&lt;/b> R&D &amp;amp; a > b\n')
    expect(md([para('> quoted')])).toBe('\\> quoted\n')
    expect(md([para('no\u00a0break')])).toBe('no&nbsp;break\n')
  })

  it('leaves plain brackets alone but escapes link-like ones', () => {
    expect(md([para('see [1] and [[wiki]]')])).toBe('see [1] and [[wiki]]\n')
    expect(md([para('[a](b)')])).toBe('\\[a\\](b)\n')
    expect(md([para('[ref]: x')])).toBe('\\[ref\\]: x\n')
  })
})

describe('links', () => {
  it('writes web links and encodes spaces and parentheses', () => {
    expect(md([para('go ', link('site', 'https://e.com/a b(c)'), '.')])).toBe(
      'go [site](https://e.com/a%20b%28c%29).\n',
    )
    expect(md([para(link('mail', 'mailto:a@b.c'))])).toBe('[mail](mailto:a@b.c)\n')
  })

  it('keeps marks inside the link text', () => {
    expect(md([para(link('x', 'https://e.com', { bold: true }))])).toBe('[**x**](https://e.com)\n')
    expect(md([para(b('a '), link('x', 'https://e.com', { bold: true }), b(' c'))])).toBe(
      '**a [x](https://e.com) c**\n',
    )
  })

  it('writes in-document and unsafe targets as plain text', () => {
    expect(md([para(link('page 3', '#page=3'))])).toBe('page 3\n')
    expect(md([para(link('x', 'javascript:alert(1)'))])).toBe('x\n')
  })

  it('escapes a ! or ] that would join the link', () => {
    expect(md([para('Wow!', link('x', 'https://e.com'))])).toBe('Wow\\![x](https://e.com)\n')
  })
})

describe('footnotes', () => {
  it('numbers by first reference across the document and collects definitions at the end', () => {
    const out = md(
      [para('a', fn('n2'), ' b'), heading(2, 'H', fn('n1')), para('again', fn('n2'))],
      { footnotes: [note('n1', ['first note']), note('n2', ['second note'])] },
    )
    expect(out).toBe('a[^1] b\n\n## H[^2]\n\nagain[^1]\n\n[^1]: second note\n\n[^2]: first note\n')
  })

  it('indents the continuation paragraphs of a long note', () => {
    expect(
      md([para('x', fn('n'))], { footnotes: [note('n', ['one'], ['two', br, 'three'])] }),
    ).toBe('x[^1]\n\n[^1]: one\n\n    two  \n    three\n')
  })

  it('appends notes nobody references, with a warning', () => {
    const r = treeToMarkdown(tree([para('x')], { footnotes: [note('lost', ['orphan'])] }))
    expect(r.markdown).toBe('x\n\n[^1]: orphan\n')
    expect(r.warnings.map((w) => w.kind)).toContain('footnoteUnreferenced')
  })

  it('keeps a marker whose note is missing as text, with a warning', () => {
    const r = treeToMarkdown(tree([para('x', { kind: 'footnoteRef', id: 'gone', marker: '7' })]))
    expect(r.markdown).toBe('x7\n')
    expect(r.warnings).toContainEqual(expect.objectContaining({ kind: 'footnoteMissing', page: 1 }))
  })

  it('keeps a following ( from turning the marker into a link', () => {
    expect(md([para('x', fn('n'), '(see)')], { footnotes: [note('n', ['y'])] })).toBe(
      'x[^1]\\(see)\n\n[^1]: y\n',
    )
  })

  it('escapes text that looks like a footnote marker', () => {
    expect(md([para('literal [^1] text')])).toBe('literal \\[^1\\] text\n')
  })

  it('reports pages whose footnotes could not be linked', () => {
    const r = treeToMarkdown(tree([para('x')], { footnoteLinkFailedPages: [4] }))
    expect(r.warnings).toContainEqual(
      expect.objectContaining({ kind: 'footnoteLinkFailed', page: 4 }),
    )
  })
})

describe('tables', () => {
  it('writes a pipe table with the first row as header', () => {
    const out = md([
      table(2, 2, [cell(0, 0, 'a'), cell(0, 1, 'b'), cell(1, 0, 'c'), cell(1, 1, 'd')]),
    ])
    expect(out).toBe('| a | b |\n| --- | --- |\n| c | d |\n')
  })

  it('un-merges spans: content in the first cell, the rest empty', () => {
    const out = md([
      table(3, 3, [
        cell(0, 0, 'wide', { colSpan: 2 }),
        cell(0, 2, 'c'),
        cell(1, 0, 'tall', { rowSpan: 2 }),
        cell(1, 1, 'x'),
        cell(1, 2, 'y'),
        cell(2, 1, 'z'),
        cell(2, 2, 'w'),
      ]),
    ])
    expect(out).toBe('| wide |  | c |\n| --- | --- | --- |\n| tall | x | y |\n|  | z | w |\n')
  })

  it('escapes pipes and joins cell paragraphs and breaks with <br>', () => {
    const out = md([
      table(1, 2, [cell(0, 0, [[tx('a|b')], [tx('c'), br, tx('d')]]), cell(0, 1, [[m('x|y')]])]),
    ])
    expect(out).toBe('| a\\|b<br>c<br>d | $x\\|y$ |\n| --- | --- |\n')
  })

  it('writes a caption as an italic paragraph after the table', () => {
    const out = md([table(1, 1, [cell(0, 0, 'a')], caption('Table 1. Data'))])
    expect(out).toBe('| a |\n| --- |\n\n*Table 1. Data*\n')
  })

  it('skips an empty grid', () => {
    expect(md([table(0, 0, []), para('x')])).toBe('x\n')
  })
})

describe('images', () => {
  it('stores pictures under assets/ by content hash, once per content', () => {
    const png = bytes(1, 2, 3)
    const jpg = bytes(9, 9)
    const r = treeToMarkdown(tree([image(png), image(jpg, { mime: 'image/jpeg' }), image(png)]))
    const h = sha256Hex(png)
    const hj = sha256Hex(jpg)
    expect(r.markdown).toBe(
      `![](assets/${h}.png)\n\n![](assets/${hj}.jpg)\n\n![](assets/${h}.png)\n`,
    )
    expect(r.assets.map((a) => a.path)).toEqual([`assets/${h}.png`, `assets/${hj}.jpg`])
    expect(r.assets[0]!.data).toBe(png)
    expect(r.manifestEntries).toEqual([
      { name: `${h}.png`, sha256: h },
      { name: `${hj}.jpg`, sha256: hj },
    ])
  })

  it('writes a caption as an italic paragraph right after the image', () => {
    const h = sha256Hex(bytes(1))
    expect(md([image(bytes(1), { caption: caption('Figure ', i('2'), ': ', b('bold')) })])).toBe(
      `![](assets/${h}.png)\n\n*Figure 2: **bold***\n`,
    )
  })

  it('keeps the caption of a figure without bytes and warns', () => {
    const r = treeToMarkdown(tree([image(bytes(), { placeholder: true, caption: caption('Fig') })]))
    expect(r.markdown).toBe('*Fig*\n')
    expect(r.assets).toEqual([])
    expect(r.warnings.map((w) => w.kind)).toEqual(['figureWithoutImage'])
  })
})

describe('math', () => {
  it('writes inline $…$ and display $$…$$', () => {
    expect(md([para('area ', m('\\pi r^2'), ' ok')])).toBe('area $\\pi r^2$ ok\n')
    expect(md([mathBlock('E = mc^2')])).toBe('$$\nE = mc^2\n$$\n')
  })

  it('escapes dollars next to a formula, leaves plain currency alone', () => {
    expect(md([para('costs $5 and ', m('x'))])).toBe('costs \\$5 and $x$\n')
    expect(md([para('costs $5 and $10')])).toBe('costs $5 and $10\n')
    expect(md([para('a $b$ c')])).toBe('a \\$b\\$ c\n')
  })

  it('adjusts formulas the strict tokenizer would refuse', () => {
    expect(md([para(m(' x '), '2')])).toBe('$x$&#50;\n')
    expect(md([para(m('a \\\\'))])).toBe('$a \\\\{}$\n')
    expect(md([para(m('5 and 10'))])).toBe('${}5 and 10$\n')
  })

  it('writes a formula with a dollar as code and warns', () => {
    const r = treeToMarkdown(tree([para(m('\\$x')), mathBlock('a\\$')]))
    expect(r.markdown).toBe('`\\$x`\n\n```latex\na\\$\n```\n')
    expect(r.warnings.map((w) => w.kind)).toEqual(['formulaAsCode', 'formulaAsCode'])
  })

  it('collapses blank lines inside a display formula', () => {
    expect(md([mathBlock('a\n\n  \nb')])).toBe('$$\na\nb\n$$\n')
  })
})

describe('page images', () => {
  it('puts only the picture in the body and the note in warnings', () => {
    const data = bytes(7, 7, 7)
    const r = treeToMarkdown(
      tree([pageBreak(1), para('text'), pageBreak(2), pageImage(2, 'degraded', data)], {
        pages: [pageInfo(1), pageInfo(2, 'degraded')],
      }),
    )
    expect(r.markdown).toBe(`text\n\n![](assets/${sha256Hex(data)}.png)\n`)
    expect(r.warnings).toEqual([
      expect.objectContaining({ kind: 'pageAsImage', page: 2, reason: 'degraded' }),
    ])
    expect(r.warnings[0]!.message).toBe('page 2 was inserted as an image')
  })

  it('a plain figure is not a page-image warning', () => {
    expect(treeToMarkdown(tree([image(bytes(1))])).warnings).toEqual([])
  })

  it('flags a document that is only page images', () => {
    const r = treeToMarkdown(
      tree([pageImage(1, 'scanned', bytes(1)), pageImage(2, 'scanned', bytes(2))], {
        pages: [pageInfo(1, 'scanned'), pageInfo(2, 'scanned')],
      }),
    )
    expect(r.warnings.map((w) => w.kind)).toEqual([
      'pageAsImage',
      'pageAsImage',
      'allPagesAsImages',
    ])
  })
})

describe('printed table of contents', () => {
  it('writes nothing for the TOC the tree kept aside', () => {
    const out = md([para('body')], {
      toc: [{ title: 'Intro', level: 1, pageLabel: '1', tocPage: 1, targetPage: 2 }],
    })
    expect(out).toBe('body\n')
  })
})

describe('translated and bilingual trees', () => {
  function source(): DocumentTree {
    return tree(
      [
        { ...at(), id: 'h', kind: 'heading', level: 1, levelSource: 'font', runs: [tx('Title')] },
        { ...at(), id: 'p', kind: 'paragraph', runs: [tx('Hello'), fn('n')] },
        { ...at(), id: 'q', kind: 'paragraph', runs: [tx('Untranslated')] },
        {
          ...image(bytes(5)),
          id: 'img',
          caption: { ...caption('Figure 1'), id: 'cap' },
        } as TreeBlock,
      ],
      {
        footnotes: [
          {
            ...note('n', ['Note']),
            blocks: [{ ...at(), id: 'fn', kind: 'paragraph', runs: [tx('Note')] }],
          },
        ],
      },
    )
  }
  const tr = new Map<string, InlineRun[]>([
    ['h', [tx('제목')]],
    ['p', [tx('안녕'), fn('n')]],
    ['cap', [tx('그림 1')]],
    ['fn', [tx('각주')]],
  ])
  const h = sha256Hex(bytes(5))

  it('accepts the source tree', () => {
    expect(treeToMarkdown(source()).markdown).toBe(
      `# Title\n\nHello[^1]\n\nUntranslated\n\n![](assets/${h}.png)\n\n*Figure 1*\n\n[^1]: Note\n`,
    )
  })

  it('writes the translated tree in place of the original', () => {
    expect(treeToMarkdown(deriveTranslatedTree(source(), 'ko', tr)).markdown).toBe(
      `# 제목\n\n안녕[^1]\n\nUntranslated\n\n![](assets/${h}.png)\n\n*그림 1*\n\n[^1]: 각주\n`,
    )
  })

  it('writes the original paragraph, then the translated one', () => {
    expect(treeToMarkdown(deriveBilingualTree(source(), 'ko', tr)).markdown).toBe(
      `# Title\n\n# 제목\n\nHello[^1]\n\n안녕[^1]\n\nUntranslated\n\n![](assets/${h}.png)\n\n*Figure 1*\n\n*그림 1*\n\n[^1]: Note\n\n    각주\n`,
    )
  })
})

describe('result shape', () => {
  it('reports no assets and no warnings for plain text', () => {
    const r: MarkdownConversion = treeToMarkdown(tree([para('x')]))
    expect(r).toEqual({ markdown: 'x\n', assets: [], manifestEntries: [], warnings: [] })
  })
})
