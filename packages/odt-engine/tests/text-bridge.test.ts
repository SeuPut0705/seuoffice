import { type ParsedDocFull, parseDocx, saveDocx, scanBody } from '@genoffice/docx-engine'
import JSZip from 'jszip'
import { beforeAll, describe, expect, it } from 'vitest'
import { type BridgeMap, editedItems } from '../src/core'
import {
  type Bridge,
  bodyOf,
  editOnly,
  editorSave,
  odtToBridge,
  replaceText,
  runText,
  writeBack,
} from './helpers/bridge'
import { buildOdt } from './helpers/build-odt'
import { hPara, hParaWith, hParagraphAutoStyle } from './helpers/hancom-fragments'
import { FIELD, textSample } from './helpers/text-fixtures'

let bridge: Bridge
let parsed: ParsedDocFull

beforeAll(async () => {
  bridge = await odtToBridge(await buildOdt(textSample().options))
  parsed = await parseDocx(bridge.docx)
})

const visible = () => parsed.blocks.filter((b) => !b.hidden)

describe('ODF → OOXML: the bridge docx', () => {
  it('opens with parseDocx, one engine block per bridge element, texts as recorded', () => {
    expect(visible().map((b) => runText(b))).toEqual(
      bridge.map.elements.map((e) => bridge.map.paragraphs[e.paragraph as number].text),
    )
    expect(visible().map((b) => b.type)).toEqual([
      'paragraph',
      'paragraph',
      'heading',
      'paragraph',
      'listItem',
      'listItem',
      'listItem',
      'paragraph',
      'paragraph',
      'paragraph',
      'paragraph',
      'paragraph',
    ])
  })

  it('records every body element exactly as written into document.xml', async () => {
    const zip = await JSZip.loadAsync(bridge.docx)
    const xml = await zip.file('word/document.xml')!.async('string')
    const scan = scanBody(xml)
    const elements = scan.elements.filter((e) => e.name !== 'w:sectPr')
    expect(elements.map((e) => xml.slice(e.start, e.end))).toEqual(
      bridge.map.elements.map((e) => e.xml),
    )
    expect(visible().map((b) => b.originalXml)).toEqual(bridge.map.elements.map((e) => e.xml))
  })

  it('the bridge map is plain JSON', () => {
    const json = JSON.stringify(bridge.ctx.map)
    expect(JSON.parse(json)).toEqual(bridge.ctx.map)
    const walk = (v: unknown): void => {
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) return
      expect(Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype).toBe(true)
      for (const x of Object.values(v as object)) walk(x)
    }
    walk(bridge.ctx.map)
  })

  it('an unedited saveDocx returns the bridge bytes and every element unchanged', async () => {
    const out = await saveDocx(
      parsed,
      visible().map((b) => ({ kind: 'original', docxIndex: b.docxIndex as number })),
    )
    expect(out).toBe(bridge.docx)
  })

  it('editing one paragraph through saveDocx keeps every other element byte-identical to the bridge', async () => {
    const { bytes } = await editorSave(
      bridge.docx,
      editOnly({ 1: (g) => replaceText(g, 0, 0, '새 ') }),
    )
    const items = editedItems(await parseDocx(bytes))
    expect(items).toHaveLength(bridge.map.elements.length)
    items.forEach((item, i) => {
      if (i === 1) expect(item.xml).not.toBe(bridge.map.elements[i].xml)
      else expect(item.xml).toBe(bridge.map.elements[i].xml)
    })
  })

  it('maps formatting into w:pPr / w:rPr', () => {
    const first = visible()[0]
    expect(first.format?.lineSpacing).toBeCloseTo(1.6)
    expect(first.format?.align).toBe('justify')
    expect(first.format?.tabStops?.map((t) => [t.val, t.pos, t.leader ?? 'none'])).toEqual([
      ['left', 1701, 'none'],
      ['right', 8500, 'dot'],
    ])
    const run = first.runs![0]
    expect(run.font).toBe('함초롬바탕')
    expect(run.sizeHalfPoints).toBe(20)
    expect(run.color).toBe('000000')
    expect(!!run.bold).toBe(false)
    expect(visible()[2]).toMatchObject({ type: 'heading', level: 1, outlineOnly: true })
    expect(visible()[6].format?.pageBreakBefore ?? visible()[7].format?.pageBreakBefore).toBe(true)
  })

  it('maps lists to numbering with levels and Korean formats', () => {
    const items = visible().filter((b) => b.type === 'listItem')
    expect(items.map((b) => [runText(b), b.list?.ilvl, b.list?.kind])).toEqual([
      ['항목 하나', 0, 'ordered'],
      ['항목 둘', 0, 'ordered'],
      ['하위 항목', 1, 'bullet'],
    ])
    const def = parsed.numbering.get(items[0].list!.numId)!
    expect(def.levels[0].numFmt).toBe('ganada')
    expect(def.levels[0].lvlText).toBe('%1.')
    expect(def.levels[1].lvlText).toBe('-')
  })

  it('maps hyperlinks, spaces, tabs and line breaks', () => {
    const link = visible()[3].runs!.find((r) => r.link)
    expect(link?.link?.href).toBe('https://example.com/a?b=1&c=2')
    expect(link?.text).toBe('여기')
    expect(runText(visible()[8])).toBe('앞 공백\t탭    공백\n둘째 줄 ')
  })

  it('records form fields by name and character offsets, with hidden position bookmarks', () => {
    const record = bridge.map.paragraphs[bridge.map.elements[1].paragraph as number]
    expect(record.text).toBe('앞 안건  내용 중간 value 뒤')
    const field = record.markers.find((m) => m.name === FIELD && m.kind === 'bookmark-start')!
    expect(field).toMatchObject({ offset: 2, field: true })
    expect(record.markers[field.pair as number]).toMatchObject({ kind: 'bookmark-end', offset: 8 })
    expect(record.markers.map((m) => [m.kind, m.offset])).toEqual([
      ['bookmark-start', 2],
      ['bookmark-end', 8],
      ['bookmark-start', 12],
      ['bookmark-end', 17],
      ['bookmark-start', 17],
      ['bookmark', 19],
    ])
    const block = visible()[1]
    expect(block.hiddenBookmarks).toContain(`_odtp${record.id}`)
    expect(block.bookmarks).toBeUndefined()
    // the OOXML pair spans the field text
    const xml = bridge.map.elements[1].xml
    expect(xml).toMatch(/w:name="_odtm\d+_0"\/><w:r>.*안건 {2}내용.*<\/w:r><w:bookmarkEnd/)
  })

  it('maps common styles to docx styles and keeps Hancom names', () => {
    const map: BridgeMap = bridge.map
    const names = map.styles.paragraph.filter((e) => e.odfName).map((e) => e.odfName)
    expect(names).toEqual(expect.arrayContaining(['바탕글', '바탕글 1', '+제목', '개요 1']))
    const entry = map.styles.paragraph.find((e) => e.odfName === '바탕글')!
    expect(parsed.styles.get(entry.styleId)?.name).toBe('바탕글')
    expect(parsed.headingStyleIds.get(1)).toBe('Heading1')
    expect(map.styles.baseParagraphStyle).toBe('Standard')
  })

  it('an unedited docx writes nothing back', async () => {
    const out = await saveDocx(parsed, [
      ...visible().map((b) => ({ kind: 'original' as const, docxIndex: b.docxIndex as number })),
    ])
    const wb = await writeBack(bridge, out)
    expect(wb.content).toBe(bridge.doc.contentXml)
    expect(wb.styles).toBe(bridge.doc.stylesXml)
    expect(wb.rctx.newAutomaticStyles('content.xml')).toEqual([])
  })
})

describe('whole documents and details', () => {
  it('the Hancom sample: unedited nothing changes; one edit leaves tables, frames, notes and fields verbatim', async () => {
    const { hancomSample } = await import('./helpers/hancom-sample')
    const sample = hancomSample()
    const b = await odtToBridge(await buildOdt(sample.options))
    const same = await writeBack(b, b.docx)
    expect(same.content).toBe(b.doc.contentXml)
    const fieldIndex = b.map.elements.findIndex(
      (e) => e.paragraph !== null && b.map.paragraphs[e.paragraph].text.startsWith('안건'),
    )
    const { bytes } = await editorSave(
      b.docx,
      editOnly({ [fieldIndex]: (g) => replaceText(g, 6, 6, '!') }),
    )
    const wb = await writeBack(b, bytes)
    const edited = sample.blocks[2]
    expect(
      bodyOf(wb.content).replace(
        /<text:p text:style-name="P1_0"><text:span text:style-name="T1"><text:bookmark-start text:name="NormalField1[\s\S]*?<\/text:p>/,
        'X',
      ),
    ).toBe(bodyOf(b.doc.contentXml).replace(edited, 'X'))
    expect(wb.content).toContain(
      '안건 <text:s/>내용!<text:bookmark-end text:name="NormalField1¡안건명¡안건명¡F¡T"/>',
    )
  })

  it('writes an explicit "off" when the docx paragraph style would turn bold on', async () => {
    const b = await odtToBridge(
      await buildOdt({
        body: hPara('보통 글자', { style: 'PB' }),
        extraCommonStyles:
          '<style:style style:name="굵게" style:family="paragraph"><style:text-properties fo:font-weight="bold"/></style:style>',
        extraContentAutomaticStyles: hParagraphAutoStyle('PB', { parent: '굵게' }),
      }),
    )
    expect(b.map.elements[0].xml).toContain('<w:b w:val="0"/><w:bCs w:val="0"/>')
    const parsed2 = await parseDocx(b.docx)
    expect(parsed2.blocks[0].runs?.[0].bold).toBe(false)
  })

  it('leading spaces are written as text:s', async () => {
    const b = await odtToBridge(
      await buildOdt({ body: hParaWith('<text:s text:c="2"/>들여 쓴 줄') }),
    )
    expect(b.map.paragraphs[0].text).toBe('  들여 쓴 줄')
    const { bytes } = await editorSave(b.docx, editOnly({ 0: (g) => replaceText(g, 8, 8, '!') }))
    const wb = await writeBack(b, bytes)
    expect(bodyOf(wb.content)).toBe(
      '<text:p text:style-name="P1_0"><text:span text:style-name="T1"><text:s text:c="2"/>들여 쓴 줄!</text:span></text:p>',
    )
  })
})

describe('page break after', () => {
  it('fo:break-after becomes a trailing page break and survives an edit without a new style', async () => {
    const b = await odtToBridge(
      await buildOdt({
        body: hPara('앞 쪽', { style: 'PA' }) + hPara('다음 쪽'),
        extraContentAutomaticStyles: hParagraphAutoStyle('PA').replace(
          'fo:line-height="160%"',
          'fo:line-height="160%" fo:break-after="page"',
        ),
      }),
    )
    expect(b.map.paragraphs[0].text).toBe('앞 쪽\f')
    const parsed2 = await parseDocx(b.docx)
    expect(runText(parsed2.blocks[0])).toBe('앞 쪽\f')
    const { bytes } = await editorSave(b.docx, editOnly({ 0: (g) => replaceText(g, 0, 0, '맨 ') }))
    const wb = await writeBack(b, bytes)
    expect(bodyOf(wb.content)).toBe(hPara('맨 앞 쪽', { style: 'PA' }) + hPara('다음 쪽'))
    expect(wb.rctx.newAutomaticStyles('content.xml')).toEqual([])
  })
})
