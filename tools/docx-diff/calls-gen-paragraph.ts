// Group `genParagraph`: generateParagraphXml of generate.ts. The context
// callbacks are counters made per call, the same on both sides; the result is
// the XML with every callback call, so an id taken or skipped shows.
//
// Every input that carries bookmarks has `bookmarkIds: true`: without an
// allocator both engines fall back to a process-wide counter whose value
// depends on what ran before, which a comparison cannot line up.
import { generateParagraphXml, type GenerateContext } from './reference/generate'
import type { GeneratedBlock, ParsedDoc, Run } from './reference/types'
import type { CallSpec, Input } from './calls-spec'

interface CtxArg {
  headingStyleIds: Array<[number, string]>
  listParagraphStyleId?: string
  bookmarkIds: boolean
  revisionIds: boolean
}

function generate(block: GeneratedBlock, arg: CtxArg) {
  const hyperlinks: string[] = []
  const bookmarks: string[] = []
  let revisions = 0
  const ctx: GenerateContext = {
    headingStyleIds: new Map(arg.headingStyleIds),
    ...(arg.listParagraphStyleId !== undefined ? { listParagraphStyleId: arg.listParagraphStyleId } : {}),
    allocateHyperlinkRel: (href) => {
      hyperlinks.push(href)
      return `rIdH${hyperlinks.length}`
    },
    ...(arg.bookmarkIds
      ? {
          allocateBookmarkId: (name: string) => {
            bookmarks.push(name)
            return 100 + bookmarks.length
          },
        }
      : {}),
    ...(arg.revisionIds
      ? {
          allocateRevisionId: () => {
            revisions++
            return `${500 + revisions}`
          },
        }
      : {}),
  }
  const xml = generateParagraphXml(block, ctx)
  return { xml, hyperlinks, bookmarks, revisions }
}

const CTXS: CtxArg[] = [
  { headingStyleIds: [[1, 'Heading1'], [2, 'Heading2'], [9, 'H9 & "x"']], listParagraphStyleId: 'ListParagraph', bookmarkIds: true, revisionIds: true },
  { headingStyleIds: [[2.5, 'Half'], [3, '']], bookmarkIds: true, revisionIds: false },
]

// ---------------------------------------------------------------- the corpus

type ParaBlock = ParsedDoc['blocks'][number]

/** Block to GeneratedBlock as compare.ts `generatedFrom` maps it: only the keys GeneratedBlock has. */
function generatedFrom(block: ParaBlock): GeneratedBlock {
  const type: GeneratedBlock['type'] =
    block.type === 'heading' ? 'heading' : block.type === 'listItem' ? 'listItem' : 'paragraph'
  return {
    type,
    ...(block.level !== undefined ? { level: block.level } : {}),
    ...(block.outlineOnly ? { outlineOnly: true } : {}),
    ...(block.styleId !== undefined ? { styleId: block.styleId } : {}),
    ...(block.list ? { list: block.list } : {}),
    ...(block.format ? { format: block.format } : {}),
    ...(block.rawPPr !== undefined ? { rawPPr: block.rawPPr } : {}),
    ...(block.bookmarks ? { bookmarks: block.bookmarks } : {}),
    ...(block.hiddenBookmarks ? { hiddenBookmarks: block.hiddenBookmarks } : {}),
    ...(block.commentStarts ? { commentStarts: block.commentStarts } : {}),
    ...(block.commentEnds ? { commentEnds: block.commentEnds } : {}),
    ...(block.sdtShell ? { sdtShell: block.sdtShell } : {}),
    runs: block.runs ?? [],
  }
}

const PER_DOC = 40

/** Paragraph, heading and list blocks of a parsed document, as saved and with the pPr rebuilt. */
export function paragraphModelInputs(doc: ParsedDoc): Input[] {
  return doc.blocks
    .filter((block) => block.type === 'paragraph' || block.type === 'heading' || block.type === 'listItem')
    .slice(0, PER_DOC)
    .flatMap((block, i) => {
      const generated = generatedFrom(block)
      const { rawPPr: _raw, ...rebuilt } = generated
      const marks: GeneratedBlock = {
        ...rebuilt,
        ...(block.paraMarkDel ? { paraMarkDel: JSON.stringify(block.paraMarkDel) } : {}),
        ...(block.paraMarkIns ? { paraMarkIns: JSON.stringify(block.paraMarkIns) } : {}),
      }
      const ctx = CTXS[i % CTXS.length]!
      return [generated, rebuilt, marks].map((b) => ({ args: { block: b, ctx } }))
    })
}

// ---------------------------------------------------------------- built blocks

const t = (text: string, extra: Partial<Run> = {}): Run => ({ text, ...extra })
const MARK = JSON.stringify({ author: 'A & B', date: '2024-02-03T04:05:06Z' })

const BLOCKS: GeneratedBlock[] = [
  { type: 'paragraph', runs: [] },
  { type: 'paragraph', runs: [t('plain'), t(' bold', { bold: true })], styleId: 'Body' },
  { type: 'paragraph', runs: [t('raw')], rawPPr: '<w:pPr><w:jc w:val="center"/></w:pPr>', format: { align: 'right' } },
  { type: 'paragraph', runs: [t('empty raw')], rawPPr: '' },
  { type: 'heading', level: 2, runs: [t('H2')] },
  { type: 'heading', level: 0, runs: [t('clamped up')] },
  { type: 'heading', level: 12, runs: [t('clamped down')] },
  { type: 'heading', level: 2.5, runs: [t('fraction')] },
  { type: 'heading', level: 4, outlineOnly: true, styleId: 'Body', runs: [t('outline')] },
  { type: 'heading', level: 1, styleId: '', runs: [t('empty style')] },
  { type: 'heading', runs: [t('no level')], format: { align: 'center', bidi: true, spaceBefore: 120, keepNext: true } },
  { type: 'listItem', list: { kind: 'bullet', numId: '3', ilvl: -1 }, runs: [t('below')] },
  { type: 'listItem', list: { kind: 'ordered', numId: '7&8', ilvl: 12.5 }, runs: [t('above')] },
  { type: 'listItem', list: { kind: 'ordered', numId: '2', ilvl: 1.5 }, styleId: 'Own', runs: [t('own style')] },
  { type: 'listItem', runs: [t('no list')] },
  {
    type: 'paragraph',
    runs: [t('link', { link: { href: 'https://example.com/?a=1&b=2' } }), t('again', { link: { href: 'https://example.com/?a=1&b=2' } })],
    bookmarks: ['Intro', 'A&B'],
    hiddenBookmarks: ['_Toc1'],
    commentStarts: ['1'],
    commentEnds: ['1', '2"'],
  },
  {
    type: 'paragraph',
    runs: [
      t('inserted', { ins: { author: 'A', date: '2024-01-01T00:00:00Z' } }),
      t('deleted', { del: { author: 'B', id: '9' } }),
      t('also', { ins: { author: 'A', id: '9' } }),
    ],
    paraMarkDel: MARK,
    paraMarkIns: MARK,
  },
  { type: 'paragraph', runs: [t('mark only')], paraMarkIns: '{"author":"X"}', format: { emptyRunSizeHalfPoints: 28 } },
  { type: 'paragraph', runs: [t('bad mark')], paraMarkDel: 'not json', paraMarkIns: null },
  { type: 'paragraph', runs: [t('ppr change')], pPrChange: JSON.stringify({ author: 'C', date: '2024-05-05T00:00:00Z', id: '4' }), format: { indentLeft: 720 } },
  { type: 'paragraph', runs: [t('ppr change null')], pPrChange: null, paraMarkDel: null },
  { type: 'paragraph', runs: [t('ppr change bad')], pPrChange: '{' },
  {
    type: 'paragraph',
    runs: [
      t('plain', { ins: { author: 'A', id: '7', date: '2026-01-01T00:00:00Z' } }),
      t('moved', { ins: { author: 'A', id: '7', date: '2026-01-01T00:00:00Z', move: 'm1' } }),
      t('gone', { del: { author: 'A', id: '8', move: 'm1' } }),
      t('gone too', { del: { author: 'A', id: '8', move: 'm2' } }),
    ],
  },
  {
    type: 'paragraph',
    runs: [t('tabs')],
    format: { tabStops: [{ pos: 720, val: 'right', leader: 'dot' }], lineSpacing: 1.5, pageBreakBefore: true, widowControl: false, textDirection: 'tbRl' },
  },
]

// ---------------------------------------------------------------- the specs

export const GEN_PARAGRAPH: CallSpec[] = [
  {
    fn: 'genParagraph.generateParagraphXml',
    argMutation: true,
    call: (_text, args) => generate(args.block as GeneratedBlock, args.ctx as CtxArg),
    fromModel: paragraphModelInputs,
    built: BLOCKS.flatMap((block) => CTXS.map((ctx) => ({ args: { block, ctx } }))),
    mutation: 'none',
  },
]
