/**
 * OOXML → ODF for paragraphs the editor changed. Every case edits the parsed
 * bridge docx the way the editor does and saves it with the docx engine's
 * `saveDocx`, so the paragraphs written back are really regenerated ones
 * (hidden bookmarks moved to the paragraph start, rawPPr reused or merged).
 */
import type { GeneratedBlock } from '@genoffice/docx-engine'
import { beforeAll, describe, expect, it } from 'vitest'
import { type OdtStyleTable, readOdtStyles, readRoot, scanOdtBody, walkNodes } from '../src/core'
import { readParagraph } from '../src/text'
import {
  type Bridge,
  type EditorOp,
  type WriteBack,
  bodyOf,
  editOnly,
  editorSave,
  generatedFrom,
  odtToBridge,
  replaceText,
  writeBack,
} from './helpers/bridge'
import { buildOdt } from './helpers/build-odt'
import { hPara } from './helpers/hancom-fragments'
import { FIELD, FIELD2, textSample } from './helpers/text-fixtures'

let bridge: Bridge
let sample: ReturnType<typeof textSample>

beforeAll(async () => {
  sample = textSample()
  bridge = await odtToBridge(await buildOdt(sample.options))
})

interface Written {
  content: string
  styles: OdtStyleTable
  /** every paragraph of the new body, in order */
  paragraphs: Array<{ xml: string; text: string; style: string | null; name: string }>
  warnings: string[]
  rctx: WriteBack['rctx']
}

async function save(
  ops: Parameters<typeof editorSave>[1],
  options?: Parameters<typeof editorSave>[2],
): Promise<Written> {
  const { bytes } = await editorSave(bridge.docx, ops, options)
  const wb = await writeBack(bridge, bytes)
  const body = scanOdtBody(wb.content)
  const prefixes = readRoot(wb.content)!.prefixes
  const styles = readOdtStyles(wb.styles, wb.content)
  const info = {
    part: 'content.xml' as const,
    xml: wb.content,
    prefixes,
    fontFaces: new Map(),
    scope: 'content' as const,
  }
  const paragraphs: Written['paragraphs'] = []
  walkNodes(body.blocks, (n) => {
    if (n.kind !== 'paragraph' && n.kind !== 'heading') return
    if (n.parent && (n.parent.kind === 'note' || n.parent.kind === 'annotation')) return false
    const m = readParagraph({ info, styles }, n)
    paragraphs.push({
      xml: wb.content.slice(n.start, n.end),
      text: m.text,
      style: m.styleName,
      name: n.name,
    })
    return false
  })
  return { content: wb.content, styles, paragraphs, warnings: wb.rctx.warnings, rctx: wb.rctx }
}

const originalBody = () => bodyOf(bridge.doc.contentXml)

describe('text edits keep everything else byte for byte', () => {
  it('a text-only edit rewrites only that paragraph and keeps its style names', async () => {
    const w = await save(editOnly({ 0: (g) => replaceText(g, 3, 3, '바뀐 ') }))
    const p = w.paragraphs[0]
    expect(p.text).toBe('첫째 바뀐 문단입니다')
    expect(p.xml).toBe(
      '<text:p text:style-name="P9_0"><text:span text:style-name="T1">첫째 바뀐 문단입니다</text:span></text:p>',
    )
    // the rest of the body is untouched
    const before = originalBody().replace(sample.blocks[1], '')
    expect(bodyOf(w.content).replace(p.xml, '')).toBe(before)
    expect(w.content.slice(0, w.content.indexOf('<office:body>'))).toBe(
      bridge.doc.contentXml.slice(0, bridge.doc.contentXml.indexOf('<office:body>')),
    )
  })

  it('deleting a paragraph removes it and keeps kept blocks in place', async () => {
    const w = await save((blocks) =>
      blocks.map((_, i) => ({ keep: i })).filter((op) => op.keep !== 0),
    )
    expect(bodyOf(w.content)).toBe(originalBody().replace(sample.blocks[1], ''))
    expect(bodyOf(w.content).startsWith('<text:sequence-decls>')).toBe(true)
  })
})

describe('formatting changes add new automatic styles that inherit everything', () => {
  it('a paragraph format change copies the original automatic style with only that attribute overridden', async () => {
    const w = await save(editOnly({ 0: (g) => (g.format = { ...g.format, align: 'center' }) }))
    const p = w.paragraphs[0]
    expect(p.style).not.toBe('P9_0')
    const style = w.styles.find(p.style!, 'paragraph', 'content')!
    const original = bridge.doc.styles.find('P9_0', 'paragraph', 'content')!
    const props = style.properties['style:paragraph-properties']
    expect(props['fo:text-align']).toBe('center')
    // every other property, Hancom attributes and the tab list included, is inherited
    const { 'fo:text-align': _a, ...rest } = original.properties['style:paragraph-properties']
    expect(props).toMatchObject(rest)
    expect(props['style:text-autospace']).toBe('none')
    expect(props['style:snap-to-layout-grid']).toBe('true')
    expect(style.tabStops).toEqual(original.tabStops)
    expect(style.parentName).toBe(original.parentName)
    // the name is new in both parts
    expect(bridge.doc.styles.all.some((s) => s.name === p.style)).toBe(false)
    // the original style is still there, untouched
    expect(w.content).toContain(bridge.doc.contentXml.slice(original.start, original.end))
  })

  it('a run format change copies the original text style with only that attribute overridden', async () => {
    const w = await save(
      editOnly({
        0: (g) => {
          const run = g.runs[0]
          const text = run.text
          g.runs = [
            { ...run, text: text.slice(0, 2) },
            { ...run, text: text.slice(2, 3), bold: true },
            { ...run, text: text.slice(3) },
          ]
        },
      }),
    )
    const p = w.paragraphs[0]
    expect(p.style).toBe('P9_0')
    expect(p.text).toBe('첫째 문단입니다')
    const spans = [...p.xml.matchAll(/text:style-name="([^"]+)">([^<]*)</g)].map((m) => [
      m[1],
      m[2],
    ])
    const bold = spans.find(([, t]) => t === ' ')!
    expect(spans.filter(([name]) => name === 'T1').map(([, t]) => t)).toEqual([
      '첫째',
      '문단입니다',
    ])
    const style = w.styles.find(bold[0], 'text', 'content')!
    const original = bridge.doc.styles.find('T1', 'text', 'content')!
    const {
      'fo:font-weight': _w,
      'style:font-weight-asian': _wa,
      'style:font-weight-complex': _wc,
      ...rest
    } = original.properties['style:text-properties']
    expect(style.properties['style:text-properties']).toMatchObject({
      ...rest,
      'fo:font-weight': 'bold',
    })
  })

  it('identical edits share one new style; names never collide with existing ones', async () => {
    const odt = await buildOdt({
      ...sample.options,
      extraContentAutomaticStyles:
        sample.options.extraContentAutomaticStyles +
        '<style:style style:name="P9_0_io1" style:family="paragraph"/>',
    })
    const local = await odtToBridge(odt)
    const center = (g: GeneratedBlock) => (g.format = { ...g.format, align: 'center' })
    const { bytes } = await editorSave(local.docx, editOnly({ 0: center, 10: center }))
    const wb = await writeBack(local, bytes)
    const added = wb.rctx.newAutomaticStyles('content.xml')
    expect(added).toHaveLength(1)
    expect(added[0]).toContain('style:name="P9_0_io2"')
  })

  it('an Enter split keeps both halves on the original automatic style (tab list, Hancom attributes)', async () => {
    const w = await save((blocks) => [
      { edit: 0, change: (g) => replaceText(g, 2, 8, '') },
      {
        insert: {
          ...generatedFrom(blocks[0]),
          runs: [{ ...blocks[0].runs![0], text: ' 문단입니다' }],
        },
      },
      ...blocks.slice(1).map((_, i) => ({ keep: i + 1 })),
    ])
    expect(w.paragraphs.slice(0, 2).map((p) => [p.text, p.style])).toEqual([
      ['첫째', 'P9_0'],
      [' 문단입니다', 'P9_0'],
    ])
    expect(w.paragraphs[1].xml).toContain(
      '<text:span text:style-name="T1"><text:s/>문단입니다</text:span>',
    )
    expect(w.rctx.newAutomaticStyles('content.xml')).toEqual([])
  })

  it('a split-off half derives from the original automatic style: everything copied, the section start dropped', async () => {
    const local = await odtToBridge(
      await buildOdt({
        body: hPara('구역을 여는 문단', { style: 'P73_0_MS1_b3' }) + hPara('다음'),
      }),
    )
    const { bytes } = await editorSave(local.docx, (blocks) => [
      { edit: 0, change: (g) => replaceText(g, 6, 9, '') },
      { insert: { ...generatedFrom(blocks[0]), runs: [{ ...blocks[0].runs![0], text: ' 문단' }] } },
      { keep: 1 },
    ])
    const wb = await writeBack(local, bytes)
    const styles = readOdtStyles(wb.styles, wb.content)
    const names = [...wb.content.matchAll(/<text:p text:style-name="([^"]+)">/g)].map((m) => m[1])
    expect(names[0]).toBe('P73_0_MS1_b3')
    const copy = styles.find(names[1], 'paragraph', 'content')!
    const original = local.doc.styles.find('P73_0_MS1_b3', 'paragraph', 'content')!
    expect(copy.automatic).toBe(true)
    expect(copy.masterPageName).toBeNull()
    expect(copy.parentName).toBe(original.parentName)
    expect(copy.properties).toEqual(original.properties)
    expect(copy.tabStops).toEqual(original.tabStops)
  })

  it('a new paragraph with no original before it takes the common style as parent', async () => {
    const w = await save((blocks) => {
      const out: EditorOp[] = blocks.map((_, i) => ({ keep: i }))
      const twin = generatedFrom(blocks[0])
      twin.runs = [{ ...twin.runs[0], text: '새 문단' }]
      out.unshift({ insert: twin })
      return out
    })
    const p = w.paragraphs[0]
    expect(p.text).toBe('새 문단')
    const style = w.styles.find(p.style!, 'paragraph', 'content')!
    expect(style.automatic).toBe(true)
    expect(style.parentName).toBe('바탕글')
    expect(style.tabStops?.map((t) => t['style:position'])).toEqual(['3.000cm', '14.993cm'])
    // the next original paragraph's text style is reused when the formatting matches
    expect(p.xml).toContain('<text:span text:style-name="T1">새 문단</text:span>')
  })
})

describe('form fields (누름틀)', () => {
  const fieldParagraph = 1
  const read = (w: Written) => w.paragraphs[1]
  const fieldText = (xml: string, name: string) => {
    const esc = name
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
    const start = `<text:bookmark-start text:name="${esc}"/>`
    const end = `<text:bookmark-end text:name="${esc}"/>`
    const a = xml.indexOf(start)
    const b = xml.indexOf(end)
    expect(a).toBeGreaterThanOrEqual(0)
    expect(b).toBeGreaterThan(a)
    return xml
      .slice(a + start.length, b)
      .replace(/<[^>]+>/g, (t) => (t.startsWith('<text:s') ? ' ' : ''))
  }

  it('typing inside the pair keeps the typed text inside it', async () => {
    const w = await save(editOnly({ [fieldParagraph]: (g) => replaceText(g, 8, 8, ' 수정') }))
    expect(read(w).text).toBe('앞 안건  내용 수정 중간 value 뒤')
    expect(fieldText(read(w).xml, FIELD)).toBe('안건  내용 수정')
    expect(fieldText(read(w).xml, FIELD2)).toBe('value')
  })

  it('editing before and after the pair moves it with its text', async () => {
    const w = await save(
      editOnly({
        [fieldParagraph]: (g) => {
          replaceText(g, 18, 19, '뒤쪽')
          replaceText(g, 0, 1, '맨 앞')
        },
      }),
    )
    expect(read(w).text).toBe('맨 앞 안건  내용 중간 value 뒤쪽')
    expect(fieldText(read(w).xml, FIELD)).toBe('안건  내용')
    expect(fieldText(read(w).xml, FIELD2)).toBe('value')
  })

  it('deleting all text inside the pair leaves an empty pair (an empty Hancom field)', async () => {
    const w = await save(editOnly({ [fieldParagraph]: (g) => replaceText(g, 2, 8, '') }))
    expect(read(w).text).toBe('앞  중간 value 뒤')
    expect(fieldText(read(w).xml, FIELD)).toBe('')
  })

  it('names and the other bookmarks survive byte for byte', async () => {
    const w = await save(editOnly({ [fieldParagraph]: (g) => replaceText(g, 0, 1, '처음') }))
    const xml = read(w).xml
    for (const raw of [
      '<text:bookmark-start text:name="NormalField2¡&lt;성명&gt; &amp; &quot;직위&quot;¡¡F¡T"/>',
      '<text:bookmark-start text:name="NormalField3¡unfinished¡¡F¡T"/>',
      '<text:bookmark text:name="CellField1¡기관명¡F"/>',
    ])
      expect(xml).toContain(raw)
  })

  it('deleting the paragraph deletes its fields', async () => {
    const w = await save((blocks) =>
      blocks.map((_, i) => ({ keep: i })).filter((op) => op.keep !== 1),
    )
    expect(w.content).not.toContain('NormalField1')
    expect(w.content).not.toContain('NormalField3')
  })
})

describe('headings, lists, hyperlinks, breaks, spaces', () => {
  it('an edited heading stays a text:h with its outline level and style', async () => {
    const w = await save(editOnly({ 2: (g) => replaceText(g, 0, 0, '새 ') }))
    const h = w.paragraphs[2]
    expect(h.name).toBe('text:h')
    expect(h.xml).toMatch(/^<text:h text:style-name="H1_0" text:outline-level="1">/)
    expect(h.text).toBe('새 제목 하나')
  })

  it('a paragraph turned into a heading becomes text:h with a heading-looking style', async () => {
    const w = await save(
      editOnly({
        10: (g) => {
          g.type = 'heading'
          g.level = 2
          g.styleId = 'Heading2'
        },
      }),
    )
    const h = w.paragraphs.find((p) => p.text === '마지막')!
    expect(h.name).toBe('text:h')
    expect(h.xml).toContain('text:outline-level="2"')
    const style = w.styles.find(h.style!, 'paragraph', 'content')!
    expect(style.properties['style:text-properties']['fo:font-weight']).toBe('bold')
    expect(style.tabStops).toEqual(bridge.doc.styles.find('P9_0', 'paragraph', 'content')!.tabStops)
  })

  it('an edited list item is rewritten inside the original list, reusing its start tag', async () => {
    const w = await save(editOnly({ 5: (g) => replaceText(g, 0, 0, '바뀐 ') }))
    const list =
      /<text:list text:style-name="NL1" xml:id="list1">[\s\S]*?<\/text:list><\/text:list-item><\/text:list>/.exec(
        w.content,
      )
    expect(list).not.toBeNull()
    expect(w.paragraphs.filter((p) => p.text.includes('항목')).map((p) => p.text)).toEqual([
      '항목 하나',
      '바뀐 항목 둘',
      '하위 항목',
    ])
    expect(list![0]).toContain(
      '<text:list-item><text:p text:style-name="P1_0"><text:span text:style-name="T1">하위 항목</text:span></text:p></text:list-item></text:list>',
    )
  })

  it('a new list item (Enter at the end of the list) joins the same list', async () => {
    const w = await save((blocks) => {
      const out: EditorOp[] = blocks.map((_, i) => ({ keep: i }))
      const twin = JSON.parse(JSON.stringify(blocks[6])) as GeneratedBlock
      twin.runs = [{ ...twin.runs[0], text: '새 하위' }]
      out.splice(7, 0, { insert: twin })
      return out
    })
    const lists = w.content.match(/<text:list[\s>]/g) ?? []
    expect(lists).toHaveLength(2) // the list and its nested level
    expect(w.paragraphs.map((p) => p.text)).toContain('새 하위')
    expect(w.content).toContain(
      '<text:list xml:id="list1"'.replace(
        ' xml:id="list1"',
        ' text:style-name="NL1" xml:id="list1"',
      ),
    )
  })

  it('a list created in the editor gets a new automatic list style', async () => {
    const w = await save(
      editOnly({
        10: (g) => {
          g.type = 'listItem'
          g.list = { kind: 'ordered', numId: '900', ilvl: 0 }
        },
      }),
      { numbering: { newDefs: [{ numId: '900', kind: 'ordered' }] } },
    )
    const m = /<text:list text:style-name="([^"]+)">(<text:list-item>[\s\S]*?)<\/text:list>/.exec(
      w.content,
    )
    expect(m).not.toBeNull()
    expect(w.styles.listStyle(m![1], 'content')?.levels[0]).toMatchObject({ kind: 'number' })
    expect(m![2]).toContain('마지막')
  })

  it('an edited hyperlink keeps the original text:a; a new link becomes text:a', async () => {
    const w = await save(
      editOnly({
        3: (g) => replaceText(g, 0, 0, '이 '),
        0: (g) => {
          const run = g.runs[0]
          g.runs = [run, { ...run, text: '링크', link: { href: 'https://example.org/' } }]
          delete g.runs[1].rawRPr
        },
      }),
    )
    expect(w.paragraphs[3].xml).toContain(
      '<text:a xlink:type="simple" xlink:href="https://example.com/a?b=1&amp;c=2" office:target-frame-name="_self" text:style-name="T_LINK">여기</text:a>',
    )
    expect(w.paragraphs[0].xml).toContain('xlink:href="https://example.org/"')
    expect(w.paragraphs[0].text).toBe('첫째 문단입니다링크')
  })

  it('a page break typed inside a paragraph splits it; the rest starts on a new page', async () => {
    const w = await save(editOnly({ 0: (g) => replaceText(g, 2, 3, '\f') }))
    expect(w.paragraphs.slice(0, 2).map((p) => p.text)).toEqual(['첫째', '문단입니다'])
    const second = w.styles.find(w.paragraphs[1].style!, 'paragraph', 'content')!
    expect(second.properties['style:paragraph-properties']['fo:break-before']).toBe('page')
    expect(w.paragraphs[0].style).toBe('P9_0')
  })

  it('removing a page-break-before turns it off in a copy of the style', async () => {
    const w = await save(
      editOnly({ 7: (g) => (g.format = { ...g.format, pageBreakBefore: false }) }),
    )
    const p = w.paragraphs.find((x) => x.text === '새 쪽')!
    const style = w.styles.find(p.style!, 'paragraph', 'content')!
    expect(style.properties['style:paragraph-properties']['fo:break-before']).toBe('auto')
  })

  it('spaces, tabs and line breaks survive an edit', async () => {
    const w = await save(editOnly({ 8: (g) => replaceText(g, 15, 15, '!') }))
    const p = w.paragraphs.find((x) => x.text.includes('탭'))!
    expect(p.text).toBe('앞 공백\t탭    공백\n둘째! 줄 ')
    expect(p.xml).toContain('<text:tab/>')
    expect(p.xml).toContain('<text:line-break/>')
    expect(p.xml).toContain('탭 <text:s text:c="3"/>공백')
  })

  it('inline constructs without a converter are kept: a field while its text is intact, a note at its offset', async () => {
    const w = await save(editOnly({ 9: (g) => replaceText(g, 0, 1, '페이지') }))
    const p = w.paragraphs.find((x) => x.text.includes('번호'))!
    expect(p.xml).toContain('<text:page-number text:select-page="current">3</text:page-number>')
    expect(p.xml).toContain('<text:note text:note-class="footnote">')
    expect(p.text).toBe('페이지 3 번호 끝')
  })
})

describe('style edits', () => {
  it('"스타일 고치기" patches only that common style, keeping its name', async () => {
    const entry = bridge.map.styles.paragraph.find((e) => e.odfName === '바탕글')!
    const { bytes } = await editorSave(
      bridge.docx,
      (blocks) => blocks.map((_, i) => ({ keep: i })),
      {
        styleUpserts: [{ styleId: entry.styleId, pPr: { align: 'center' }, rPr: { bold: true } }],
      },
    )
    const wb = await writeBack(bridge, bytes)
    expect(wb.content).toBe(bridge.doc.contentXml)
    const original = bridge.doc.stylesXml!
    const style = bridge.doc.styles.common('바탕글', 'paragraph')!
    const oldXml = original.slice(style.start, style.end)
    const newXml = wb.styles.slice(style.start, wb.styles.length - (original.length - style.end))
    expect(wb.styles.slice(0, style.start)).toBe(original.slice(0, style.start))
    expect(wb.styles.slice(style.start + newXml.length)).toBe(original.slice(style.end))
    expect(newXml).toContain('style:name="바탕글"')
    expect(newXml).toContain('fo:text-align="center"')
    expect(newXml).toContain('fo:font-weight="bold"')
    expect(
      newXml
        .replace('fo:text-align="center"', 'fo:text-align="justify"')
        .replace(
          / fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold"/,
          '',
        ),
    ).toBe(oldXml)
  })

  it('"기본 글꼴 바꾸기" patches only the default style', async () => {
    const { bytes } = await editorSave(
      bridge.docx,
      (blocks) => blocks.map((_, i) => ({ keep: i })),
      {
        defaultFonts: { font: 'Arial', eastAsiaFont: '맑은 고딕' },
      },
    )
    const wb = await writeBack(bridge, bytes)
    const styles = readOdtStyles(wb.styles, wb.content)
    const def = styles.defaultStyle('text')!
    expect(def.properties['style:text-properties']).toMatchObject({
      'fo:font-family': 'Arial',
      'style:font-family-asian': "'맑은 고딕'",
    })
    // fonts are declared, names kept everywhere else
    expect(wb.styles).toContain('<style:font-face style:name="Arial" svg:font-family="Arial"/>')
    for (const name of ['바탕글', '바탕글 1', '+제목', '개요 1'])
      expect(styles.common(name, 'paragraph')).toBeDefined()
  })
})

describe('clearing formatting in the editor', () => {
  const marked = 11
  const clear = (change: (run: GeneratedBlock['runs'][number]) => void) =>
    save(editOnly({ [marked]: (g) => g.runs.forEach(change) }))
  const markedStyle = (w: Written) => {
    const p = w.paragraphs.find((x) => x.text === '강조된 글자')!
    const name = /<text:span text:style-name="([^"]+)">/.exec(p.xml)![1]
    expect(name).not.toBe('T_MARK')
    return w.styles.find(name, 'text', 'content')!.properties['style:text-properties']
  }

  it('clearing the colour removes it from the copied text style', async () => {
    const props = markedStyle(await clear((r) => delete r.color))
    expect(props['fo:color']).toBeUndefined()
    expect(props['fo:background-color']).toBe('#ffff00')
    expect(props['style:letter-kerning']).toBe('false')
  })

  it('clearing the highlight makes the background transparent', async () => {
    const props = markedStyle(
      await clear((r) => {
        delete r.shading
        delete r.highlight
      }),
    )
    expect(props['fo:background-color']).toBe('transparent')
    expect(props['fo:color']).toBe('#ff0000')
  })

  it('removing the underline turns it off', async () => {
    const props = markedStyle(await clear((r) => (r.underline = false)))
    expect(props['style:text-underline-style']).toBe('none')
  })

  it('resetting the size takes the size the paragraph style gives', async () => {
    const props = markedStyle(await clear((r) => delete r.sizeHalfPoints))
    // 바탕글 (the common parent) is 10pt
    expect(props['fo:font-size']).toBe('10.00pt')
    expect(props['style:font-size-asian']).toBe('10.00pt')
  })

  it('removing an indent removes it from the copied paragraph style', async () => {
    const w = await save(
      editOnly({
        0: (g) => {
          g.format = { ...g.format }
          delete g.format.indentLeft
        },
      }),
    )
    const p = w.paragraphs[0]
    expect(p.style).not.toBe('P9_0')
    const style = w.styles.find(p.style!, 'paragraph', 'content')!
    const props = style.properties['style:paragraph-properties']
    expect(props['fo:margin-left']).toBeUndefined()
    expect(props['fo:margin-right']).toBe('0cm')
    expect(props['style:text-autospace']).toBe('none')
    expect(style.tabStops).toEqual(bridge.doc.styles.find('P9_0', 'paragraph', 'content')!.tabStops)
  })

  it('an untouched paragraph next to the cleared one is not rewritten', async () => {
    const w = await clear((r) => delete r.color)
    expect(w.paragraphs.find((x) => x.text === '마지막')!.xml).toBe(sample.blocks[9])
  })
})

describe('form fields follow their text across paragraph splits and joins', () => {
  const fieldIndex = 1
  const twinOf = (blocks: Parameters<Parameters<typeof editorSave>[1]>[0], text: string) => ({
    insert: {
      ...generatedFrom(blocks[fieldIndex]),
      runs: [{ ...blocks[fieldIndex].runs![0], text }],
    },
  })
  const split = (keepText: (g: GeneratedBlock) => void, twinText: string) =>
    save((blocks) => [
      { keep: 0 },
      { edit: fieldIndex, change: keepText },
      twinOf(blocks, twinText),
      ...blocks.slice(2).map((_, i) => ({ keep: i + 2 })),
    ])
  const pair = (xml: string, name: string) => {
    const esc = name
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
    const a = xml.indexOf(`<text:bookmark-start text:name="${esc}"/>`)
    const b = xml.indexOf(`<text:bookmark-end text:name="${esc}"/>`)
    return a >= 0 && b > a
      ? xml
          .slice(a, b)
          .replace(/<text:bookmark-start[^>]*>/, '')
          .replace(/<text:s\/>/g, ' ')
          .replace(/<text:s text:c="(\d+)"\/>/g, (_m, n: string) => ' '.repeat(Number(n)))
          .replace(/<[^>]+>/g, '')
      : null
  }
  const others = ['NormalField3¡unfinished¡¡F¡T', 'CellField1¡기관명¡F']

  it('Enter just before a field moves the whole pair with its text', async () => {
    const w = await split((g) => replaceText(g, 2, 19, ''), '안건  내용 중간 value 뒤')
    const [first, second] = [w.paragraphs[1], w.paragraphs[2]]
    expect([first.text, second.text]).toEqual(['앞 ', '안건  내용 중간 value 뒤'])
    expect(first.xml).not.toContain('NormalField')
    expect(pair(second.xml, FIELD)).toBe('안건  내용')
    expect(pair(second.xml, FIELD2)).toBe('value')
    for (const name of others) expect(second.xml).toContain(name)
  })

  it('Enter inside a field keeps the pair together, with the bigger part of its text', async () => {
    const w = await split((g) => replaceText(g, 4, 19, ''), '  내용 중간 value 뒤')
    const [first, second] = [w.paragraphs[1], w.paragraphs[2]]
    expect([first.text, second.text]).toEqual(['앞 안건', '  내용 중간 value 뒤'])
    // "안건" (2 characters) stays above, "  내용" (4) moves down: the pair goes with the bigger part
    expect(pair(second.xml, FIELD)).toBe('  내용')
    expect(first.xml).not.toContain('NormalField1')
    expect(pair(second.xml, FIELD2)).toBe('value')
    expect(w.warnings.some((x) => x.includes('split by a new paragraph'))).toBe(true)
  })

  it('Enter at the paragraph start leaves an empty line above and every marker with the text', async () => {
    const w = await split((g) => replaceText(g, 0, 19, ''), '앞 안건  내용 중간 value 뒤')
    const [first, second] = [w.paragraphs[1], w.paragraphs[2]]
    expect([first.text, second.text]).toEqual(['', '앞 안건  내용 중간 value 뒤'])
    expect(first.xml).not.toContain('text:bookmark')
    expect(pair(second.xml, FIELD)).toBe('안건  내용')
    expect(pair(second.xml, FIELD2)).toBe('value')
    for (const name of others) expect(second.xml).toContain(name)
  })

  it('Backspace joining a paragraph keeps the fields of its second half', async () => {
    const w = await save((blocks) => [
      {
        edit: 0,
        change: (g) => {
          g.runs = [...g.runs, ...JSON.parse(JSON.stringify(blocks[fieldIndex].runs))]
        },
      },
      ...blocks.slice(2).map((_, i) => ({ keep: i + 2 })),
    ])
    const merged = w.paragraphs[0]
    expect(merged.text).toBe('첫째 문단입니다앞 안건  내용 중간 value 뒤')
    expect(pair(merged.xml, FIELD)).toBe('안건  내용')
    expect(pair(merged.xml, FIELD2)).toBe('value')
    for (const name of others) expect(merged.xml).toContain(name)
    expect(w.paragraphs[1].text).toBe('제목 하나')
  })

  it('a deleted paragraph still takes its fields with it', async () => {
    const w = await save((blocks) => [
      { edit: 0, change: (g) => replaceText(g, 0, 0, '바뀐 ') },
      ...blocks.slice(2).map((_, i) => ({ keep: i + 2 })),
    ])
    expect(w.content).not.toContain('NormalField')
    expect(w.paragraphs[0].text).toBe('바뀐 첫째 문단입니다')
  })
})
