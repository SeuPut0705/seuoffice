// The edits of comparison (b), `saveOdt`: what the Word editor does to the
// bridge docx of an ODT, made once on the TypeScript side, so that both
// engines save the same edited docx. They are the editor edits of
// packages/odt-engine/tests/helpers/bridge.ts (`editorSave`: keep, edit,
// insert, xml; `replaceText`) and of the layer tests: a paragraph's text, a
// format, a split and a join, a cell, a regenerated table (rows, columns), a
// margin and a section break, a header, a picture resized or replaced, the
// note and comment lists, the personal information, the styles and the
// default fonts.
import {
  parseDocx,
  type Block,
  type GeneratedBlock,
  type ParsedDocFull,
  type SectionInfo,
  type TableModel,
} from '@seuoffice/docx-engine'
import { withClock } from './clock'
import * as ts from './ts'

const { editorSave, editOnly, replaceText, generatedFrom } = ts.helpersBridge
const { sectionsOf, sectPrRewrite, editedHf, keepAllBut } = ts.helpersPageBridge
const { patchCells, regenerate, cellRuns, editRuns } = ts.helpersTableEditor
const { drawingOf, resizeDrawing, PNG_GREY } = ts.helpersObjectsFixtures

export interface EditCase {
  name: string
  docx: Uint8Array
}

type Ops = Parameters<typeof editorSave>[1]
type Options = NonNullable<Parameters<typeof editorSave>[2]>

const keep = (blocks: unknown[]): Array<{ keep: number }> => blocks.map((_, i) => ({ keep: i }))
const textOfBlock = (b: Block): string => (b.runs ?? []).map((r) => r.text).join('')
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

const isTextual = (b: Block): boolean =>
  (b.type === 'paragraph' || b.type === 'heading' || b.type === 'listItem') &&
  textOfBlock(b).length > 0

/** Texts typed into a paragraph: ASCII, Korean, the code points whose case mapping leaves ASCII, an astral character. */
const TYPED = [
  'X',
  '\ud55c\uae00 \uc785\ub825',
  '\u0131\u017f\u212a',
  '\ud83d\ude00',
  ' ',
  '\ta\nb',
]

/** How an edit is made: the editor's save of ops, or a ready docx. */
type Maker = () => Promise<Uint8Array>

interface Candidate {
  name: string
  make: Maker
}

const save =
  (docx: Uint8Array, ops: Ops, options?: Options): Maker =>
  async () =>
    (await editorSave(docx, ops, options)).bytes

/**
 * The edited docxes for one bridge docx. `random` picks which of the edits
 * the document allows are made (`limit` of them, always including the
 * unedited ones), so each document is edited the same way on every run.
 */
export async function editsFor(
  docx: Uint8Array,
  bridgeStyles: ts.BridgeMap['styles'] | undefined,
  random: () => number,
  limit: number,
): Promise<{ edits: EditCase[]; failed: number }> {
  const candidates: Candidate[] = []
  const always: Candidate[] = [
    { name: 'keep all', make: save(docx, keep) },
    { name: 'the bridge docx as it is', make: async () => docx },
  ]
  let parsed: ParsedDocFull
  try {
    parsed = await withClock(() => parseDocx(docx))
  } catch {
    return { edits: await finish(always), failed: 0 }
  }
  const visible = parsed.blocks.filter((b) => !b.hidden)
  const textual = visible
    .map((b, i) => [b, i] as const)
    .filter(([b]) => isTextual(b))
    .map(([, i]) => i)
  const add = (name: string, make: Maker): void => {
    candidates.push({ name, make })
  }

  // the text of a paragraph: first, last, a seeded one; typed at the start, inside, at the end, a range deleted
  const targets = [
    ...new Set([
      textual[0],
      textual[textual.length - 1],
      textual[Math.floor(random() * textual.length)],
    ]),
  ].filter((i): i is number => i !== undefined)
  for (const target of targets) {
    const length = textOfBlock(visible[target]!).length
    const typed = TYPED[Math.floor(random() * TYPED.length)]!
    add(
      `type at the start of ${target}`,
      save(docx, editOnly({ [target]: (g) => replaceText(g, 0, 0, typed) })),
    )
    add(
      `type inside ${target}`,
      save(
        docx,
        editOnly({
          [target]: (g) => replaceText(g, Math.floor(length / 2), Math.floor(length / 2), typed),
        }),
      ),
    )
    add(
      `type at the end of ${target}`,
      save(docx, editOnly({ [target]: (g) => replaceText(g, length, length, typed) })),
    )
    add(
      `delete a range of ${target}`,
      save(docx, editOnly({ [target]: (g) => replaceText(g, 0, Math.min(length, 2), '') })),
    )
    add(
      `replace the text of ${target}`,
      save(
        docx,
        editOnly({
          [target]: (g) =>
            replaceText(g, 0, length, '\u0131\u017f\u212a \ud55c\uae00 \ud83d\ude00'),
        }),
      ),
    )
    add(`empty ${target}`, save(docx, editOnly({ [target]: (g) => replaceText(g, 0, length, '') })))
    add(
      `align ${target}`,
      save(docx, editOnly({ [target]: (g) => (g.format = { ...g.format, align: 'center' }) })),
    )
    add(
      `bold a run of ${target}`,
      save(
        docx,
        editOnly({
          [target]: (g) => {
            const run = g.runs[0]
            if (!run) return
            const half = Math.max(1, Math.floor(run.text.length / 2))
            g.runs = [
              { ...run, text: run.text.slice(0, half), bold: true },
              { ...run, text: run.text.slice(half) },
            ]
          },
        }),
      ),
    )
    add(
      `page break before ${target}`,
      save(
        docx,
        editOnly({ [target]: (g) => (g.format = { ...g.format, pageBreakBefore: true }) }),
      ),
    )
    add(
      `heading ${target}`,
      save(
        docx,
        editOnly({
          [target]: (g) => {
            g.type = 'heading'
            g.level = 2
            g.styleId = 'Heading2'
          },
        }),
      ),
    )
    add(
      `list item ${target}`,
      save(
        docx,
        editOnly({
          [target]: (g) => {
            g.type = 'listItem'
            g.list = { kind: 'ordered', numId: '900', ilvl: 0 }
          },
        }),
        { numbering: { newDefs: [{ numId: '900', kind: 'ordered' }] } },
      ),
    )
    add(
      `page break inside ${target}`,
      save(docx, editOnly({ [target]: (g) => replaceText(g, 1, 2, '\f') })),
    )
    add(
      `link in ${target}`,
      save(
        docx,
        editOnly({
          [target]: (g) => {
            const run = g.runs[0]
            if (!run) return
            g.runs = [
              run,
              { ...run, text: '\ub9c1\ud06c', link: { href: 'https://example.org/?a=1&b=2' } },
            ]
            delete g.runs[1]!.rawRPr
          },
        }),
      ),
    )
    add(
      `delete ${target}`,
      save(docx, (blocks) => keep(blocks).filter((op) => op.keep !== target)),
    )
    add(
      `split ${target}`,
      save(docx, (blocks) => [
        ...blocks.slice(0, target).map((_, i) => ({ keep: i })),
        {
          edit: target,
          change: (g: GeneratedBlock) => replaceText(g, Math.floor(length / 2), length, ''),
        },
        {
          insert: {
            ...generatedFrom(blocks[target]!),
            runs: [
              {
                ...blocks[target]!.runs![0]!,
                text: textOfBlock(blocks[target]!).slice(Math.floor(length / 2)),
              },
            ],
          },
        },
        ...blocks.slice(target + 1).map((_, i) => ({ keep: i + target + 1 })),
      ]),
    )
    add(
      `insert after ${target}`,
      save(docx, (blocks) => [
        ...blocks.slice(0, target + 1).map((_, i) => ({ keep: i })),
        {
          insert: {
            ...generatedFrom(blocks[target]!),
            runs: [{ ...blocks[target]!.runs![0]!, text: '\uc0c8 \ubb38\ub2e8' }],
          },
        },
        ...blocks.slice(target + 1).map((_, i) => ({ keep: i + target + 1 })),
      ]),
    )
    add(
      `insert before ${target}`,
      save(docx, (blocks) => [
        {
          insert: {
            ...generatedFrom(blocks[target]!),
            runs: [{ ...blocks[target]!.runs![0]!, text: '\uc55e \ubb38\ub2e8' }],
          },
        },
        ...keep(blocks),
      ]),
    )
  }
  if (textual.length >= 2) {
    const [a, b] = [textual[0]!, textual[1]!]
    add(
      `join ${a} and ${b}`,
      save(docx, (blocks) => [
        ...blocks.slice(0, a).map((_, i) => ({ keep: i })),
        {
          edit: a,
          change: (g: GeneratedBlock) => {
            g.runs = [...g.runs, ...clone(blocks[b]!.runs ?? [])]
          },
        },
        ...blocks
          .map((_, i) => i)
          .filter((i) => i > a && i !== b)
          .map((i) => ({ keep: i })),
      ]),
    )
    add(
      `edit two paragraphs ${a} and ${b}`,
      save(
        docx,
        editOnly({
          [a]: (g) => replaceText(g, 0, 0, '>> '),
          [b]: (g) => replaceText(g, 0, 1, '\uace0\uce68'),
        }),
      ),
    )
  }
  if (visible.length > 0) {
    add(
      'empty filler paragraph at the end',
      save(docx, (blocks) => [...keep(blocks), { xml: '<w:p></w:p>' }]),
    )
    add(
      'typed paragraph at the end',
      save(docx, (blocks) => [...keep(blocks), { xml: '<w:p><w:r><w:t>\ub05d</w:t></w:r></w:p>' }]),
    )
    add(
      'delete every block',
      save(docx, () => []),
    )
  }

  // tables
  const tables = visible
    .map((b, i) => [b, i] as const)
    .filter(([b]) => b.type === 'table' && b.table)
  for (const [block, index] of tables.slice(0, 2)) {
    const rows = block.table!.rows
    add(
      `cell text in table ${index}`,
      save(docx, (blocks) =>
        blocks.map((b, i) =>
          i === index
            ? patchCells(b, [
                { row: 0, tc: 0, paras: [{ runs: editRuns(cellRuns(b, 0, 0), 0, 0, '\uce78') }] },
              ])
            : { keep: i },
        ),
      ),
    )
    add(
      `cell text, Unicode, in table ${index}`,
      save(docx, (blocks) =>
        blocks.map((b, i) =>
          i === index
            ? patchCells(b, [
                {
                  row: rows.length - 1,
                  tc: rows[rows.length - 1]!.length - 1,
                  paras: [
                    {
                      runs: editRuns(
                        cellRuns(b, rows.length - 1, rows[rows.length - 1]!.length - 1),
                        0,
                        0,
                        '\u0131\ud83d\ude00',
                      ),
                    },
                  ],
                },
              ])
            : { keep: i },
        ),
      ),
    )
    add(
      `regenerate table ${index} unchanged`,
      save(docx, (blocks) =>
        blocks.map((b, i) => (i === index ? regenerate(b, () => {}) : { keep: i })),
      ),
    )
    add(
      `fill a cell of table ${index}`,
      save(docx, (blocks) =>
        blocks.map((b, i) =>
          i === index
            ? regenerate(b, (m) => {
                m.rows[0]![0]!.fill = 'FF0000'
              })
            : { keep: i },
        ),
      ),
    )
    add(
      `insert a row in table ${index}`,
      save(docx, (blocks) =>
        blocks.map((b, i) => (i === index ? regenerate(b, (m) => insertRow(m, 1)) : { keep: i })),
      ),
    )
    add(
      `delete a row of table ${index}`,
      save(docx, (blocks) =>
        blocks.map((b, i) =>
          i === index
            ? regenerate(b, (m) => {
                if (m.rows.length > 1) m.rows.splice(1, 1)
              })
            : { keep: i },
        ),
      ),
    )
    add(
      `insert a column in table ${index}`,
      save(docx, (blocks) =>
        blocks.map((b, i) =>
          i === index ? regenerate(b, (m) => insertColumn(m, 1)) : { keep: i },
        ),
      ),
    )
    add(
      `delete a column of table ${index}`,
      save(docx, (blocks) =>
        blocks.map((b, i) =>
          i === index
            ? regenerate(b, (m) => {
                if ((m.rows[0]?.length ?? 0) > 1) for (const row of m.rows) row.splice(0, 1)
              })
            : { keep: i },
        ),
      ),
    )
    add(
      `merge two cells of table ${index}`,
      save(docx, (blocks) =>
        blocks.map((b, i) =>
          i === index
            ? regenerate(b, (m) => {
                const row = m.rows[0]
                if (row && row.length > 1) {
                  row[0]!.colSpan = 2
                  row.splice(1, 1)
                }
              })
            : { keep: i },
        ),
      ),
    )
  }

  // pictures: a resize of the drawing, a replaced picture
  const pictureBlocks = visible
    .map((b, i) => [b, i] as const)
    .filter(([b]) => (b.originalXml ?? '').includes('odt-pic:'))
  for (const [block, index] of pictureBlocks.slice(0, 2)) {
    const xml = block.originalXml as string
    add(
      `resize the picture of ${index}`,
      save(docx, (blocks) =>
        blocks.map((b, i) =>
          i === index
            ? {
                xml: xml.replace(drawingOf(xml), resizeDrawing(drawingOf(xml), 1828800, 914400)),
                docxIndex: b.docxIndex as number,
              }
            : { keep: i },
        ),
      ),
    )
    add(
      `replace the picture of ${index}`,
      save(
        docx,
        (blocks) =>
          blocks.map((b, i) =>
            i === index
              ? {
                  kind: 'xml',
                  xml,
                  docxIndex: b.docxIndex as number,
                  replaceImage: {
                    base64: Buffer.from(PNG_GREY).toString('base64'),
                    mime: 'image/png',
                  },
                }
              : { keep: i },
          ) as never,
      ),
    )
  }
  const placeholders = visible
    .map((b, i) => [b, i] as const)
    .filter(([b]) => /name="odt-keep:/.test(b.originalXml ?? ''))
  for (const [block, index] of placeholders.slice(0, 2)) {
    const xml = block.originalXml as string
    add(
      `resize the placeholder of ${index}`,
      save(docx, (blocks) =>
        blocks.map((b, i) =>
          i === index
            ? { xml: resizeDrawing(xml, 100000, 100000), docxIndex: b.docxIndex as number }
            : { keep: i },
        ),
      ),
    )
  }

  // notes and comments
  if (parsed.footnotes.length > 0) {
    add(
      'edit a footnote',
      save(docx, keep, {
        footnotes: parsed.footnotes.map((n, i) => ({
          id: n.id,
          text: i === 0 ? '\uace0\uce5c \uac01\uc8fc \u0131\ud83d\ude00' : n.text,
        })),
      }),
    )
    add(
      'delete a footnote text',
      save(docx, keep, { footnotes: parsed.footnotes.map((n) => ({ id: n.id, text: '' })) }),
    )
  }
  if (parsed.endnotes.length > 0) {
    add(
      'edit an endnote',
      save(docx, keep, {
        endnotes: parsed.endnotes.map((n) => ({ id: n.id, text: '\ubbf8\uc8fc \uace0\uce68' })),
      }),
    )
  }
  if (textual.length > 0) {
    const target = textual[0]!
    add(
      'a new footnote',
      save(
        docx,
        editOnly({
          [target]: (g) => {
            g.runs.push({ text: '9', noteRef: { kind: 'footnote', id: '9' } })
          },
        }),
        {
          footnotes: [
            ...parsed.footnotes.map((n) => ({ id: n.id, text: n.text })),
            { id: '9', text: '\uc0c8 \uac01\uc8fc' },
          ],
        },
      ),
    )
    add(
      'a new comment',
      save(
        docx,
        editOnly({
          [target]: (g) => {
            g.runs = g.runs.map((r) => ({ ...r, commentIds: ['7'] }))
          },
        }),
        {
          comments: [
            ...(parsed.comments ?? []).map((c) => ({ id: c.id, author: c.author, text: c.text })),
            { id: '7', author: 'me', text: '\uc0c8 \uba54\ubaa8' },
          ],
        },
      ),
    )
  }
  if ((parsed.comments ?? []).length > 0) {
    add('delete the comments', save(docx, keep, { comments: [] }))
    add(
      'delete commented text',
      save(
        docx,
        editOnly({
          [textual[0] ?? 0]: (g) =>
            replaceText(g, 0, textOfBlock(visible[textual[0] ?? 0] ?? ({} as Block)).length, ''),
        }),
      ),
    )
  }
  if (parsed.footnotes.length > 0 && tables.length > 0) {
    add(
      'edit a footnote with a table edit',
      save(
        docx,
        (blocks) =>
          blocks.map((b, i) => (i === tables[0]![1] ? regenerate(b, () => {}) : { keep: i })),
        { footnotes: parsed.footnotes.map((n) => ({ id: n.id, text: n.text + '!' })) },
      ),
    )
  }

  // the package: personal information, styles, fonts
  add('remove personal information', save(docx, keep, { removePersonalInfo: true }))
  const styleId = bridgeStyles?.paragraph[0]?.styleId
  if (styleId !== undefined) {
    add(
      'upsert a paragraph style',
      save(docx, keep, {
        styleUpserts: [{ styleId, pPr: { align: 'center' }, rPr: { bold: true } }] as never,
      }),
    )
  }
  add(
    'default fonts',
    save(docx, keep, {
      defaultFonts: { font: 'Arial', eastAsiaFont: '\ub9d1\uc740 \uace0\ub515' } as never,
    }),
  )

  // pages: a margin, a section break, a header, numbering, a first-page header
  let sectionsView: { parsed: ParsedDocFull; sections: SectionInfo[]; visible: Block[] } | undefined
  try {
    sectionsView = await sectionsOf(docx)
  } catch {
    sectionsView = undefined
  }
  const sections = sectionsView?.sections ?? []
  if (sectionsView && sections.length > 0) {
    const view = sectionsView
    const last = sections[sections.length - 1]!
    add(
      'last section margin',
      save(docx, keep, {
        section: { ...last.settings, marginLeft: last.settings.marginLeft + 567 },
      }),
    )
    add(
      'last section paper',
      save(docx, keep, {
        section: {
          ...last.settings,
          orientation: 'landscape',
          pageWidth: last.settings.pageHeight,
          pageHeight: last.settings.pageWidth,
        },
      }),
    )
    add('last section columns', save(docx, keep, { section: { ...last.settings, columns: 1 } }))
    add('page numbering', save(docx, keep, { pgNumType: { fmt: 'upperRoman', start: 3 } }))
    add('page numbering start only', save(docx, keep, { pgNumType: { start: 4 } }))
    add(
      'different first page',
      save(docx, keep, {
        titlePg: true,
        headerFirst: { text: 'first', paras: [{ runs: [{ text: 'first' }] }] } as never,
      }),
    )
    add('different first page off', save(docx, keep, { titlePg: false }))
    add(
      'different even pages',
      save(docx, keep, {
        evenAndOddHeaders: true,
        headerEven: { text: 'even', paras: [{ runs: [{ text: 'even' }] }] } as never,
      }),
    )
    add('different even pages off', save(docx, keep, { evenAndOddHeaders: false }))
    add('mirror margins', save(docx, keep, { mirrorMargins: true }))
    add('page color', save(docx, keep, { pageColor: 'FFFF00' }))
    const rId = last.headerRefs.default
    if (rId !== undefined) {
      add(
        'trailing header',
        save(docx, keep, {
          header: editedHf(view.parsed, rId, (paras) => replaceText(paras[0] as never, 0, 0, '!')),
        }),
      )
      add(
        'trailing header, a paragraph more',
        save(docx, keep, {
          header: editedHf(view.parsed, rId, (paras) => {
            paras.push(clone({ ...paras[0]!, runs: [{ ...paras[0]!.runs[0]!, text: 'more' }] }))
          }),
        }),
      )
    }
    if (last.footerRefs?.default !== undefined) {
      const footer = last.footerRefs.default
      add(
        'trailing footer',
        save(docx, keep, {
          footer: editedHf(view.parsed, footer, (paras) =>
            replaceText(paras[0] as never, 0, 0, '\ucabd '),
          ),
        }),
      )
    }
    add(
      'trailing footer, created',
      save(docx, keep, {
        footer: { text: '\ucabd', paras: [{ runs: [{ text: '\ucabd' }] }] } as never,
      }),
    )
    for (const [n, section] of sections.entries()) {
      const idx = n
      if (section === last) continue
      const rewrite = sectPrRewrite(view.parsed, section, {
        settings: { marginLeft: section.settings.marginLeft + 567 },
      })
      add(`margin of section ${idx}`, save(docx, keepAllBut({ [rewrite.docxIndex]: rewrite.xml })))
      const rewriteSize = sectPrRewrite(view.parsed, section, {
        settings: { pageWidth: 20000, marginTop: section.settings.marginTop + 567 },
      })
      add(
        `size of section ${idx}`,
        save(docx, keepAllBut({ [rewriteSize.docxIndex]: rewriteSize.xml })),
      )
      const rewriteNum = sectPrRewrite(view.parsed, section, {
        pageNumber: { fmt: 'lowerRoman', start: 2 },
      })
      add(
        `numbering of section ${idx}`,
        save(docx, keepAllBut({ [rewriteNum.docxIndex]: rewriteNum.xml })),
      )
      const first = section.headerRefs.default
      if (first !== undefined) {
        const hf = editedHf(view.parsed, first, (paras) =>
          replaceText(paras[0] as never, 0, 6, 'HEADER'),
        )
        add(
          `header of section ${idx}`,
          save(docx, keep, {
            sectionHf: [{ lastBlockIndex: section.lastBlockIndex, kind: 'header', hf }],
          }),
        )
        const gone = editedHf(view.parsed, first, (paras) => {
          replaceText(paras[0] as never, 0, 8, 'NEW')
          paras.splice(1)
        })
        add(
          `header of section ${idx}, shortened`,
          save(docx, keep, {
            sectionHf: [{ lastBlockIndex: section.lastBlockIndex, kind: 'header', hf: gone }],
          }),
        )
      }
      add(
        `remove the break of section ${idx}`,
        save(docx, (blocks) =>
          blocks.map((b, i) =>
            b.docxIndex === section.lastBlockIndex
              ? {
                  xml: ts.pageSectpr.stripParagraphSectPr(
                    view.parsed.blocks.find((x) => x.docxIndex === section.lastBlockIndex)
                      ?.originalXml as string,
                  ),
                  docxIndex: b.docxIndex as number,
                }
              : { keep: i },
          ),
        ),
      )
    }
    // a break added in the editor: a paragraph that holds the first section's sectPr
    add(
      'a break added',
      save(docx, (blocks) => [
        { keep: 0 },
        { xml: `<w:p><w:pPr>${sections[0]!.sectPrXml}</w:pPr></w:p>` },
        ...blocks.slice(1).map((_, i) => ({ keep: i + 1 })),
      ]),
    )
    add(
      'a break added before an edit',
      save(docx, (blocks) => [
        { keep: 0 },
        { xml: `<w:p><w:pPr>${sections[0]!.sectPrXml}</w:pPr></w:p>` },
        ...(blocks.length > 1
          ? [{ edit: 1, change: (g: GeneratedBlock) => replaceText(g, 0, 0, 'new ') }]
          : []),
        ...blocks.slice(2).map((_, i) => ({ keep: i + 2 })),
      ]),
    )
  }

  // the choice: the unedited ones, and `limit` of the others
  const chosen: Candidate[] = [...always]
  const pool = [...candidates]
  while (chosen.length < limit + always.length && pool.length > 0) {
    chosen.push(pool.splice(Math.floor(random() * pool.length), 1)[0]!)
  }
  return finish(chosen).then((edits) => ({ edits, failed: chosen.length - edits.length }))
}

async function finish(chosen: Candidate[]): Promise<EditCase[]> {
  const out: EditCase[] = []
  for (const { name, make } of chosen) {
    try {
      out.push({ name, docx: await withClock(make) })
    } catch {
      // an edit the TypeScript editor helpers refuse on this document is not an edit
    }
  }
  return out
}

function withText(
  cell: NonNullable<TableModel['rows'][number][number]>,
  text: string,
): typeof cell {
  const c = clone(cell)
  const para = c.richParas?.[0] ?? { runs: [] }
  const run = para.runs[0] ?? { text: '' }
  c.richParas = [{ ...para, runs: text ? [{ ...run, text }] : [] }]
  c.paras = [text]
  delete c.vMerge
  delete c.colSpan
  return c
}

const ROW_ARRAYS = ['rowHeightsTwips', 'rowHeightRules', 'repeatHeaderRows', 'rawTrPrs'] as const

function insertRow(m: TableModel, at: number): void {
  const like = m.rows[Math.max(0, at - 1)]
  if (!like) return
  m.rows.splice(
    at,
    0,
    like.map((cell) => withText(cell, '\ud589')),
  )
  for (const key of ROW_ARRAYS) {
    const arr = m[key] as unknown[] | undefined
    if (arr) arr.splice(at, 0, key === 'repeatHeaderRows' ? false : arr[Math.max(0, at - 1)])
  }
}

function insertColumn(m: TableModel, at: number): void {
  for (const row of m.rows) {
    const like = row[Math.max(0, at - 1)]
    if (like) row.splice(at, 0, withText(like, '\uc5f4'))
  }
  m.colWidthsTwips?.splice(at, 0, m.colWidthsTwips[Math.max(0, at - 1)]!)
  m.colWidthsPct?.splice(at, 0, m.colWidthsPct[Math.max(0, at - 1)]!)
}
