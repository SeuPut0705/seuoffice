/**
 * The public API end to end: `odtToDocx` → the editor's save → `saveOdt`.
 * No edit gives the original bytes; one edit changes only its part (and only
 * its element in it); the package is re-packed the standard way; meta.xml is
 * touched only by personal-information removal; encrypted files are refused
 * with the typed error; the report and the plain text cover what they promise.
 */
import { describe, expect, it } from 'vitest'
import { OdtEncryptedError, isOdtOpenError, odtToDocx, odtToText, saveOdt } from '../src'
import { readOdtPackage } from '../src/core'
import { changedRegion, diffPackages, expectedOrder, roundTrip, textOf } from './helpers/api'
import { type EditorOp, editOnly, editorSave, replaceText } from './helpers/bridge'
import { buildOdt, buildOdtPackage } from './helpers/build-odt'
import {
  hCell,
  hFootnote,
  hFramedTable,
  hPara,
  hParaWith,
  hRow,
  hTable,
} from './helpers/hancom-fragments'
import { hancomSample } from './helpers/hancom-sample'
import { drawingOf, resizeDrawing } from './helpers/objects-fixtures'
import { editedHf, sectionsOf } from './helpers/page-bridge'
import { pageDoc } from './helpers/page-fixtures'
import { cellRuns, editRuns, patchCells } from './helpers/table-editor'

const keepAll = (blocks: unknown[]) => blocks.map((_, i) => ({ keep: i }))

describe('saveOdt without edits', () => {
  it('returns the original bytes for the hancom sample', async () => {
    const odt = await buildOdt(hancomSample().options)
    const { saved, docx } = await roundTrip(odt, keepAll)
    expect(saved).toEqual(odt)
    // the bridge docx itself saved back is no edit either
    const { bridge } = await odtToDocx(odt)
    expect(await saveOdt({ originalOdt: odt, bridge, editedDocx: docx })).toEqual(odt)
  })

  it('does not modify the bridge map it is given', async () => {
    const odt = await buildOdt(pageDoc())
    const { docxBytes, bridge } = await odtToDocx(odt)
    const before = JSON.stringify(bridge)
    const { bytes } = await editorSave(docxBytes, editOnly({ 0: (g) => replaceText(g, 0, 0, 'x') }))
    await saveOdt({ originalOdt: odt, bridge, editedDocx: bytes })
    expect(JSON.stringify(bridge)).toBe(before)
  })
})

describe('saveOdt with one edit', () => {
  it('a paragraph edit changes only content.xml, only inside that paragraph', async () => {
    const sample = hancomSample()
    const odt = await buildOdt(sample.options)
    const target = sample.blocks.indexOf(sample.pieces.sectionBreakParagraph) + 1
    const paragraph = sample.blocks[target]
    const { saved } = await roundTrip(odt, (blocks) => {
      const i = blocks.findIndex(
        (b) => (b.runs ?? []).map((r) => r.text).join('') === 'after  section',
      )
      return blocks.map((_, k) =>
        k === i ? { edit: k, change: (g) => replaceText(g, 0, 5, 'before') } : { keep: k },
      )
    })
    const diff = await diffPackages(odt, saved)
    expect(diff.changed).toEqual(['content.xml'])
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.order).toEqual(await expectedOrder(odt))
    expect(diff.mimetypeFirst).toBe(true)
    expect(diff.mimetypeStored).toBe(true)
    const before = textOf(await readOdtPackage(odt), 'content.xml')
    const after = textOf(await readOdtPackage(saved), 'content.xml')
    const region = changedRegion(before, after)
    expect(paragraph).toContain(region.before)
    expect(after).toBe(before.replace(paragraph, paragraph.replace('after', 'before')))
  })

  it('a cell edit changes only that cell', async () => {
    const cellA = hCell(hPara('a'))
    const table = hTable('Table1', 2, [hRow([cellA, hCell(hPara('b'))])])
    const framed = hFramedTable(table)
    const options = { body: hPara('앞') + framed.paragraph + hPara('뒤') }
    const odt = await buildOdt(options)
    const { saved } = await roundTrip(odt, (blocks) =>
      blocks.map((b, i) =>
        b.type === 'table'
          ? patchCells(b, [
              { row: 0, tc: 0, paras: [{ runs: editRuns(cellRuns(b, 0, 0), 1, 1, '1') }] },
            ])
          : { keep: i },
      ),
    )
    const diff = await diffPackages(odt, saved)
    expect(diff.changed).toEqual(['content.xml'])
    const before = textOf(await readOdtPackage(odt), 'content.xml')
    const after = textOf(await readOdtPackage(saved), 'content.xml')
    expect(after).toBe(before.replace(cellA, hCell(hPara('a1'))))
  })

  it('a picture resize changes only the frame size', async () => {
    const sample = hancomSample()
    const odt = await buildOdt(sample.options)
    const { saved } = await roundTrip(odt, (blocks) =>
      blocks.map((b, i) => {
        const xml = b.originalXml ?? ''
        if (!xml.includes('odt-pic:')) return { keep: i }
        const drawing = drawingOf(xml)
        return {
          xml: xml.replace(drawing, resizeDrawing(drawing, 1828800, 914400)),
          docxIndex: b.docxIndex as number,
        }
      }),
    )
    const diff = await diffPackages(odt, saved)
    expect(diff.changed).toEqual(['content.xml'])
    const before = textOf(await readOdtPackage(odt), 'content.xml')
    const after = textOf(await readOdtPackage(saved), 'content.xml')
    const frame = sample.pieces.image.frame
    expect(after).toBe(
      before.replace(
        frame,
        frame.replace(
          'svg:width="4.547cm" svg:height="1.342cm"',
          'svg:width="5.08cm" svg:height="2.54cm"',
        ),
      ),
    )
  })

  it('a header edit changes only styles.xml', async () => {
    const odt = await buildOdt(pageDoc())
    const { docxBytes, bridge } = await odtToDocx(odt)
    const { parsed, sections } = await sectionsOf(docxBytes)
    const rId = sections[1].headerRefs.default as string
    const hf = editedHf(parsed, rId, (paras) => replaceText(paras[0] as never, 0, 6, 'HEADER'))
    const { bytes } = await editorSave(docxBytes, keepAll, {
      sectionHf: [{ lastBlockIndex: sections[1].lastBlockIndex, kind: 'header', hf }],
    })
    const saved = await saveOdt({ originalOdt: odt, bridge, editedDocx: bytes })
    const diff = await diffPackages(odt, saved)
    expect(diff.changed).toEqual(['styles.xml'])
    const before = textOf(await readOdtPackage(odt), 'styles.xml')
    const after = textOf(await readOdtPackage(saved), 'styles.xml')
    expect(changedRegion(before, after)).toEqual({ before: 'header', after: 'HEADER' })
  })
})

describe('the editor paragraph after a final table', () => {
  // the editor keeps an empty paragraph after a table that ends the document
  // and saves it as a bare w:p the bridge never had
  const filler: EditorOp = { xml: '<w:p></w:p>' }
  const editFirst = (blocks: unknown[]): EditorOp[] =>
    blocks.map((_, i) =>
      i === 0 ? { edit: 0, change: (g) => replaceText(g, 0, 1, '첫') } : { keep: i },
    )

  it.each([
    ['a body table', () => hTable('Table1', 1, [hRow([hCell(hPara('b'))])])],
    [
      'a framed table',
      () => hFramedTable(hTable('Table1', 1, [hRow([hCell(hPara('b'))])])).paragraph,
    ],
  ])('is not written when the document ends with %s', async (_, last) => {
    const odt = await buildOdt({ body: hPara('앞') + last() })
    const { saved } = await roundTrip(odt, (blocks) => [...editFirst(blocks), filler])
    const before = textOf(await readOdtPackage(odt), 'content.xml')
    const after = textOf(await readOdtPackage(saved), 'content.xml')
    expect(after).toBe(before.replace(hPara('앞'), hPara('첫')))
  })

  it('is written when the paragraph has text', async () => {
    const odt = await buildOdt({
      body: hPara('앞') + hTable('Table1', 1, [hRow([hCell(hPara('b'))])]),
    })
    const typed = { xml: '<w:p><w:r><w:t>끝</w:t></w:r></w:p>' }
    const { saved } = await roundTrip(odt, (blocks) => [
      ...blocks.map((_, i) => ({ keep: i })),
      typed,
    ])
    const after = textOf(await readOdtPackage(saved), 'content.xml')
    expect(after).toMatch(/<\/table:table><text:p [^>]*>(?:<text:span[^>]*>)?끝/)
  })

  it('an empty new last paragraph is kept when the document ends with a paragraph', async () => {
    const odt = await buildOdt({ body: hPara('앞') })
    const { saved } = await roundTrip(odt, (blocks) => [
      ...blocks.map((_, i) => ({ keep: i })),
      filler,
    ])
    const before = textOf(await readOdtPackage(odt), 'content.xml')
    const after = textOf(await readOdtPackage(saved), 'content.xml')
    expect(after).not.toBe(before)
    expect(after).toContain(`${hPara('앞')}<text:p `)
  })
})

describe('a heading written as a paragraph with an outline-level style', () => {
  // how docxToOdt writes headings (Hancom numbers every text:h)
  const headingStyle =
    '<style:style style:name="Heading1" style:family="paragraph" style:display-name="Heading 1" style:default-outline-level="1"><style:text-properties fo:font-weight="bold"/></style:style>'
  const body = '<text:p text:style-name="Heading1">제목</text:p>' + hPara('본문')

  it('stays a text:p when its text is edited', async () => {
    const odt = await buildOdt({ body, extraCommonStyles: headingStyle })
    const { saved } = await roundTrip(odt, (blocks) => {
      expect(blocks[0]!.type).toBe('heading')
      return blocks.map((_, i) =>
        i === 0 ? { edit: 0, change: (g) => replaceText(g, 0, 0, '새 ') } : { keep: i },
      )
    })
    const after = textOf(await readOdtPackage(saved), 'content.xml')
    expect(after).toContain('<text:p text:style-name="Heading1">새 제목</text:p>')
    expect(after).not.toContain('<text:h')
  })

  it('becomes a text:h when another heading style is applied', async () => {
    const odt = await buildOdt({ body, extraCommonStyles: headingStyle })
    const { saved } = await roundTrip(odt, (blocks) =>
      blocks.map((_, i) =>
        i === 0
          ? {
              edit: 0,
              change: (g) => {
                g.level = 2
                g.styleId = 'Heading2'
              },
            }
          : { keep: i },
      ),
    )
    expect(textOf(await readOdtPackage(saved), 'content.xml')).toContain('text:outline-level="2"')
  })
})

describe('meta.xml', () => {
  it('is rewritten only when personal information is removed', async () => {
    const built = await buildOdtPackage({ body: hPara('본문') })
    const odt = built.bytes
    const { saved } = await roundTrip(odt, keepAll, { removePersonalInfo: true })
    const diff = await diffPackages(odt, saved)
    expect(diff.changed).toEqual(['meta.xml'])
    const meta = textOf(await readOdtPackage(saved), 'meta.xml')
    expect(built.metaXml).toContain('<dc:creator>tester</dc:creator>')
    expect(meta).toBe(built.metaXml.replace('<dc:creator>tester</dc:creator>', ''))
  })

  it('the bridge docx carries the people fields', async () => {
    const odt = await buildOdt({ body: hPara('본문') })
    const { docxBytes } = await odtToDocx(odt)
    const { readDocxPart } = await import('../src/core')
    const core = await readDocxPart(docxBytes, 'docProps/core.xml')
    expect(core).toContain('<cp:lastModifiedBy>tester</cp:lastModifiedBy>')
  })
})

describe('typed open errors', () => {
  it('a password-protected ODT is refused by every entry point', async () => {
    const odt = await buildOdt({ encrypted: true })
    for (const run of [() => odtToDocx(odt), () => odtToText(odt)]) {
      const err = await run().then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(OdtEncryptedError)
      expect(isOdtOpenError(err, 'encrypted')).toBe(true)
    }
  })

  it('a non-zip is corrupt', async () => {
    const err = await odtToDocx(new TextEncoder().encode('not a zip')).catch((e: unknown) => e)
    expect(isOdtOpenError(err, 'corrupt')).toBe(true)
  })
})

describe('odtToDocx report', () => {
  it('lists what saving as docx would change', async () => {
    const { report } = await odtToDocx(await buildOdt(hancomSample().options))
    const byFeature = Object.fromEntries(report.map((r) => [`${r.kind}:${r.feature}`, r.count]))
    expect(byFeature['converted:equation']).toBe(1)
    expect(byFeature['converted:toc']).toBe(1)
    expect(byFeature['converted:form_field']).toBe(3)
    expect(byFeature['dropped:protection']).toBe(1)
    expect(byFeature['converted:shape'] ?? 0).toBeGreaterThanOrEqual(1)
    for (const r of report) expect(r.count).toBeGreaterThan(0)
  })
})

describe('odtToText', () => {
  it('reads paragraphs, framed and nested tables, and notes', async () => {
    const nested = hTable('Table3', 2, [hRow([hCell(hPara('x')), hCell(hPara('y'))])])
    const body =
      hParaWith(`본문${hFootnote('각주 글')} 끝`) +
      hFramedTable(hTable('Table1', 2, [hRow([hCell(hPara('가')), hCell(hPara('나'))])]))
        .paragraph +
      hTable('Table2', 1, [hRow([hCell(hPara('host') + nested)])]) +
      hPara('마지막')
    const text = await odtToText(await buildOdt({ body }))
    expect(text).toBe('본문1) 끝\n가\t나\nhost x y\n마지막\n\n1) 각주 글')
  })
})
