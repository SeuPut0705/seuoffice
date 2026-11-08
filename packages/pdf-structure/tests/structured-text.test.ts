/** Structured text for the AI read path (spec §2): one case per element kind. */
import { describe, expect, it } from 'vitest'
import {
  FOOTNOTES_LABEL,
  TOC_LABEL,
  aiReadPayloadText,
  formatStructuredPage,
  pageImageNote,
  treeToStructuredText,
} from '../src/structured-text'
import type {
  CaptionBlock,
  DocumentTree,
  FootnoteDef,
  InlineRun,
  PageInfo,
  TableCell,
  TextRun,
  TocEntry,
  TreeBlock,
} from '../src/tree'

let seq = 0
const at = (page: number) => ({
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
const runs = (xs: (InlineRun | string)[]): InlineRun[] =>
  xs.map((x) => (typeof x === 'string' ? tx(x) : x))

const para = (page: number, ...xs: (InlineRun | string)[]): TreeBlock => ({
  ...at(page),
  kind: 'paragraph',
  runs: runs(xs),
})
const heading = (page: number, level: 1 | 2 | 3 | 4 | 5 | 6, text: string): TreeBlock => ({
  ...at(page),
  kind: 'heading',
  level,
  levelSource: 'font',
  runs: [tx(text)],
})
const item = (
  page: number,
  ordered: boolean,
  level: number,
  text: string,
  marker?: string,
): TreeBlock => ({
  ...at(page),
  kind: 'listItem',
  ordered,
  level,
  ...(marker ? { marker } : {}),
  runs: [tx(text)],
})
const caption = (page: number, text: string, position: 'above' | 'below'): CaptionBlock => ({
  ...at(page),
  kind: 'caption',
  position,
  runs: [tx(text)],
})
const cell = (
  row: number,
  col: number,
  text: string,
  span: { rowSpan?: number; colSpan?: number } = {},
): TableCell => ({
  row,
  col,
  rowSpan: span.rowSpan ?? 1,
  colSpan: span.colSpan ?? 1,
  paragraphs: [[tx(text)]],
})
const pageBreak = (page: number): TreeBlock => ({ ...at(page), kind: 'pageBreak' })
const pageInfo = (page: number, status: PageInfo['status'] = 'text'): PageInfo => ({
  page,
  fingerprint: `fp${page}`,
  status,
  widthPt: 612,
  heightPt: 792,
})
const note = (id: string, page: number, text: string, marker?: string): FootnoteDef => ({
  id,
  page,
  pageFingerprint: `fp${page}`,
  ...(marker ? { marker } : {}),
  blocks: [{ ...at(page), kind: 'paragraph', runs: [tx(text)] }],
})

function tree(
  pages: number[],
  blocks: TreeBlock[],
  extra: Partial<Pick<DocumentTree, 'footnotes' | 'toc' | 'pages'>> = {},
): DocumentTree {
  return {
    version: 1,
    variant: 'original',
    info: {},
    sourcePageCount: Math.max(1, ...pages),
    pages: extra.pages ?? pages.map((p) => pageInfo(p)),
    blocks: pages.flatMap((p) => [pageBreak(p), ...blocks.filter((b) => b.page === p)]),
    footnotes: extra.footnotes ?? [],
    outline: [],
    toc: extra.toc ?? [],
    footnoteLinkFailedPages: [],
    warnings: [],
  }
}

const textOf = (t: DocumentTree, page: number): string =>
  treeToStructuredText(t).find((p) => p.page === page)?.text ?? '(missing)'

describe('treeToStructuredText', () => {
  it('keys pages by original page number, one entry per analyzed page, in page order', () => {
    const t = tree([5, 3], [para(3, 'Third page.'), para(5, 'Fifth page.')])
    expect(treeToStructuredText(t)).toEqual([
      { page: 3, text: 'Third page.' },
      { page: 5, text: 'Fifth page.' },
    ])
  })

  it('gives a page without body blocks an empty text (furniture is not in the tree)', () => {
    const t = tree([1, 2], [para(1, 'Body.')])
    expect(treeToStructuredText(t)).toEqual([
      { page: 1, text: 'Body.' },
      { page: 2, text: '' },
    ])
  })

  it('writes headings with # by level', () => {
    const t = tree(
      [1],
      [heading(1, 1, 'Chapter One'), heading(1, 3, 'A section'), para(1, 'Body.')],
    )
    expect(textOf(t, 1)).toBe('# Chapter One\n\n### A section\n\nBody.')
  })

  it('writes paragraphs as plain text: marks dropped, breaks kept, formulas in $', () => {
    const t = tree(
      [1],
      [
        para(
          1,
          tx('Bold', { bold: true }),
          ' and ',
          tx('a link', { href: 'https://example.com' }),
          { kind: 'lineBreak' },
          'Energy ',
          { kind: 'math', latex: 'E=mc^2' },
          '.',
        ),
        para(1, 'Second\nline joined.'),
      ],
    )
    expect(textOf(t, 1)).toBe('Bold and a link\nEnergy $E=mc^2$.\n\nSecond line joined.')
  })

  it('writes list items as a list, ordered ones with their numbers, nested by level', () => {
    const t = tree(
      [1],
      [
        item(1, false, 0, 'apples', '•'),
        item(1, false, 1, 'green'),
        item(1, true, 0, 'first', '1.'),
        item(1, true, 0, 'second'),
        para(1, 'After.'),
      ],
    )
    expect(textOf(t, 1)).toBe('- apples\n  - green\n1. first\n2. second\n\nAfter.')
  })

  it('writes tables as Markdown pipe tables, merged cells un-merged', () => {
    const table: TreeBlock = {
      ...at(1),
      kind: 'table',
      table: {
        rowCount: 3,
        colCount: 3,
        cells: [
          cell(0, 0, 'Name'),
          cell(0, 1, 'Score', { colSpan: 2 }),
          cell(1, 0, 'Ann', { rowSpan: 2 }),
          cell(1, 1, '9|10'),
          cell(1, 2, 'A'),
          cell(2, 1, '7'),
          cell(2, 2, 'B'),
        ],
      },
      caption: caption(1, 'Table 1. Scores', 'above'),
    }
    expect(textOf(tree([1], [table]), 1)).toBe(
      [
        'Table 1. Scores',
        '',
        '| Name | Score |  |',
        '| --- | --- | --- |',
        '| Ann | 9\\|10 | A |',
        '|  | 7 | B |',
      ].join('\n'),
    )
  })

  it('writes a multi-paragraph table cell on one line', () => {
    const table: TreeBlock = {
      ...at(1),
      kind: 'table',
      table: {
        rowCount: 1,
        colCount: 1,
        cells: [{ row: 0, col: 0, rowSpan: 1, colSpan: 1, paragraphs: [[tx('a')], [tx('b')]] }],
      },
    }
    expect(textOf(tree([1], [table]), 1)).toBe('| a<br>b |\n| --- |')
  })

  it('writes figures as a marker with their caption', () => {
    const figure: TreeBlock = {
      ...at(1),
      kind: 'image',
      data: new Uint8Array([1]),
      mime: 'image/png',
      pixelWidth: 1,
      pixelHeight: 1,
      widthPt: 1,
      heightPt: 1,
      caption: caption(1, 'Figure 2. A chart', 'below'),
    }
    expect(textOf(tree([1], [figure]), 1)).toBe('[figure]\n\nFigure 2. A chart')
  })

  it('writes display formulas between $$', () => {
    const math: TreeBlock = { ...at(1), kind: 'math', latex: 'a^2 + b^2 = c^2' }
    expect(textOf(tree([1], [math]), 1)).toBe('$$\na^2 + b^2 = c^2\n$$')
  })

  it('puts the notes of a page in a footnotes block at the end of that page', () => {
    const t = tree(
      [1, 2],
      [
        para(1, 'Claim', { kind: 'footnoteRef', id: 'n1', marker: '1' }, ' and more.'),
        para(1, 'Next paragraph.'),
        para(2, 'Other', { kind: 'footnoteRef', id: 'n2' }, '.'),
      ],
      { footnotes: [note('n1', 1, 'Source one.', '1'), note('n2', 2, 'Source two.', '*')] },
    )
    expect(textOf(t, 1)).toBe(
      `Claim[^1] and more.\n\nNext paragraph.\n\n${FOOTNOTES_LABEL}\n[^1] Source one.`,
    )
    expect(textOf(t, 2)).toBe(`Other[^*].\n\n${FOOTNOTES_LABEL}\n[^*] Source two.`)
  })

  it('numbers a note without a printed marker', () => {
    const t = tree([1], [para(1, 'X', { kind: 'footnoteRef', id: 'n9' })], {
      footnotes: [note('n9', 1, 'Unmarked note.')],
    })
    expect(textOf(t, 1)).toBe(`X[^1]\n\n${FOOTNOTES_LABEL}\n[^1] Unmarked note.`)
  })

  it('marks a page kept as an image instead of inventing text', () => {
    const pageImage = (page: number, reason: 'scanned' | 'degraded'): TreeBlock => ({
      ...at(page),
      kind: 'pageImage',
      reason,
      data: new Uint8Array([1]),
      mime: 'image/png',
      pixelWidth: 1,
      pixelHeight: 1,
      widthPt: 1,
      heightPt: 1,
    })
    const t = tree([1, 2], [pageImage(1, 'scanned'), pageImage(2, 'degraded')], {
      pages: [pageInfo(1, 'scanned'), pageInfo(2, 'degraded')],
    })
    expect(textOf(t, 1)).toBe(pageImageNote(1, 'scanned'))
    expect(textOf(t, 2)).toBe(pageImageNote(2, 'degraded'))
    expect(pageImageNote(1, 'scanned')).toMatch(/page 1 is an image/i)
  })

  it('lists the entries of a printed table of contents on its page', () => {
    const toc: TocEntry[] = [
      { title: 'Introduction', level: 1, pageLabel: '1', tocPage: 2, targetPage: 3 },
      { title: 'Background', level: 2, pageLabel: '4', tocPage: 2 },
    ]
    const t = tree([2], [], { toc, pages: [pageInfo(2, 'toc')] })
    expect(textOf(t, 2)).toBe(`${TOC_LABEL}\n- Introduction … 1\n  - Background … 4`)
  })
})

describe('formatStructuredPage', () => {
  it('formats one page from its blocks and notes', () => {
    expect(
      formatStructuredPage({
        page: 4,
        blocks: [heading(4, 2, 'Title'), para(4, 'Text', { kind: 'footnoteRef', id: 'a' })],
        footnotes: [note('a', 4, 'Note.', 'a')],
      }),
    ).toBe(`## Title\n\nText[^a]\n\n${FOOTNOTES_LABEL}\n[^a] Note.`)
  })
})

describe('aiReadPayloadText', () => {
  it('formats a payload of content blocks through the same formatter', () => {
    const payload = {
      version: 1,
      blocks: [
        { kind: 'heading', level: 1, runs: [{ kind: 'text', text: 'Scanned title' }] },
        {
          kind: 'paragraph',
          runs: [
            { kind: 'text', text: 'Body' },
            { kind: 'footnoteRef', id: '1' },
          ],
        },
        {
          kind: 'table',
          table: {
            rowCount: 1,
            colCount: 2,
            cells: [
              {
                row: 0,
                col: 0,
                rowSpan: 1,
                colSpan: 1,
                paragraphs: [[{ kind: 'text', text: 'a' }]],
              },
              {
                row: 0,
                col: 1,
                rowSpan: 1,
                colSpan: 1,
                paragraphs: [[{ kind: 'text', text: 'b' }]],
              },
            ],
          },
        },
        { kind: 'figure', caption: { position: 'below', runs: [{ kind: 'text', text: 'Fig 1' }] } },
        { kind: 'math', latex: 'x' },
      ],
      footnotes: [{ label: '1', paragraphs: [[{ kind: 'text', text: 'AI note.' }]] }],
      droppedRepetitions: 0,
      reasked: false,
    }
    expect(aiReadPayloadText(payload, 7)).toBe(
      [
        '# Scanned title',
        'Body[^1]',
        '| a | b |\n| --- | --- |',
        '[figure]',
        'Fig 1',
        '$$\nx\n$$',
        `${FOOTNOTES_LABEL}\n[^1] AI note.`,
      ].join('\n\n'),
    )
  })

  it('reads a payload only through the AI-read reader: another shape counts as absent', () => {
    // no plain-text fallback and no lenient skipping: what the reader rejects is re-read later
    expect(aiReadPayloadText({ version: 1, text: '  Read by AI.  ' }, 1)).toBeNull()
    const broken = {
      version: 1,
      blocks: [{ kind: 'mystery', runs: [] }],
      footnotes: [],
      droppedRepetitions: 0,
      reasked: false,
    }
    expect(aiReadPayloadText(broken, 1)).toBeNull()
    expect(aiReadPayloadText({ ...broken, blocks: [], version: 2 }, 1)).toBeNull()
  })

  it('answers null for a payload it cannot read', () => {
    expect(aiReadPayloadText(null, 1)).toBeNull()
    expect(aiReadPayloadText({ version: 1 }, 1)).toBeNull()
    expect(aiReadPayloadText({ version: 1, text: 3 }, 1)).toBeNull()
  })

  it('keeps a note the text points at under its printed label, whatever the fingerprint', () => {
    const payload = {
      version: 1,
      blocks: [
        {
          kind: 'paragraph',
          runs: [
            { kind: 'text', text: 'See' },
            { kind: 'footnoteRef', id: '*' },
          ],
        },
      ],
      footnotes: [{ label: '*', paragraphs: [[{ kind: 'text', text: 'Starred.' }]] }],
      droppedRepetitions: 1,
      reasked: true,
    }
    const text = `See[^*]

${FOOTNOTES_LABEL}
[^*] Starred.`
    expect(aiReadPayloadText(payload, 3)).toBe(text)
    expect(aiReadPayloadText(payload, 3, 'fp3')).toBe(text)
  })

  it('reads an empty page as empty text', () => {
    expect(
      aiReadPayloadText(
        { version: 1, blocks: [], footnotes: [], droppedRepetitions: 0, reasked: false },
        1,
      ),
    ).toBe('')
  })
})
