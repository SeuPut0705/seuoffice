import { PAGE_MARK } from '@seuoffice/docx-engine'
import { describe, expect, it } from 'vitest'
import { buildOdt } from './helpers/build-odt'
import { hPara } from './helpers/hancom-fragments'
import { hancomSample } from './helpers/hancom-sample'
import { editorSave, odtToBridge, writeBack } from './helpers/bridge'
import { pageExtOf } from './helpers/bridge-ext'
import { sectionsOf } from './helpers/page-bridge'
import {
  RUN_TEXTS,
  elementNamed,
  layoutXml,
  masterXml,
  pageDoc,
  singleRun,
} from './helpers/page-fixtures'

/** Twips of an ODF length in cm (every length in these fixtures is one). */
const cm = (v: string) => (Number.parseFloat(v) * 1440) / 2.54

describe('page runs → docx sections', () => {
  it('makes one docx section per page run, with its master page geometry', async () => {
    const bridge = await odtToBridge(await buildOdt(pageDoc()))
    const { sections, visible } = await sectionsOf(bridge.docx)
    expect(sections).toHaveLength(3)
    const texts = (s: (typeof sections)[number]) =>
      visible
        .filter(
          (b) =>
            (b.docxIndex ?? -1) >= s.firstBlockIndex && (b.docxIndex ?? -1) <= s.lastBlockIndex,
        )
        .map((b) => (b.runs ?? []).map((r) => r.text).join(''))
    expect(sections.map(texts)).toEqual([
      RUN_TEXTS.slice(0, 2),
      RUN_TEXTS.slice(2, 4),
      RUN_TEXTS.slice(4, 6),
    ])
    const [one, two, three] = sections.map((s) => s.settings)
    // ODF puts the header inside the top margin: body top = margin + header height
    expect(one.marginTop).toBe(Math.round(cm('1cm') + cm('1.5cm')))
    expect(one.headerDist).toBe(Math.round(cm('1cm')))
    expect(one.marginBottom).toBe(Math.round(cm('1cm') + cm('1cm')))
    expect(one.footerDist).toBe(Math.round(cm('1cm')))
    expect(one.marginLeft).toBe(Math.round(cm('2cm')))
    expect(one.pageWidth).toBe(11906)
    expect(two.orientation).toBe('landscape')
    expect(two.pageWidth).toBe(16838)
    expect(three).toEqual(one)
    expect(sections.map((s) => s.startType)).toEqual(['nextPage', 'nextPage', 'nextPage'])
  })

  it('gives every run its own header/footer parts, read back with their text', async () => {
    const bridge = await odtToBridge(await buildOdt(pageDoc()))
    const { parsed, sections } = await sectionsOf(bridge.docx)
    const header = (i: number) => parsed.hfParts?.[sections[i].headerRefs.default ?? '']?.text
    expect([header(0), header(1), header(2)]).toEqual(['header', 'header 2', 'header'])
    expect(sections[0].headerRefs.default).not.toBe(sections[2].headerRefs.default)
    // run 2 has no footer, but must not inherit run 1's: a blank part
    expect(parsed.hfParts?.[sections[1].footerRefs.default ?? '']?.text).toBe('')
    const ext = pageExtOf(bridge.map)
    expect(ext?.runs.map((r) => r.master)).toEqual(['Standard', 'MP2', 'Standard'])
    expect(ext?.parts[sections[1].footerRefs.default ?? '']?.fill).toBe('empty')
  })

  it('maps first-page and left-page regions onto titlePg and even headers', async () => {
    const doc = pageDoc({
      masterStyles:
        masterXml('Standard', 'Mpm1', {
          header: ['plain'],
          'header-left': ['left'],
          'header-first': ['first'],
          footer: ['foot'],
        }) + masterXml('MP2', 'Mpm2', { header: ['header 2'] }),
    })
    const bridge = await odtToBridge(await buildOdt(doc))
    const { parsed, sections } = await sectionsOf(bridge.docx)
    expect(parsed.evenAndOddHeaders).toBe(true)
    expect(sections[0].titlePg).toBe(true)
    expect(sections[1].titlePg).toBe(false)
    const text = (rId: string | undefined) => parsed.hfParts?.[rId ?? '']?.text
    expect(text(sections[0].headerRefs.first)).toBe('first')
    expect(text(sections[0].headerRefs.even)).toBe('left')
    expect(text(sections[0].headerRefs.default)).toBe('plain')
    // a first page without footer-first shows the plain footer (ODF fallback)
    expect(text(sections[0].footerRefs.first)).toBe('foot')
    // MP2 has no left header: its left pages show its plain header
    expect(text(sections[1].headerRefs.even)).toBe('header 2')
  })

  it('shows columns (page layout and text:section) and page numbering', async () => {
    const body =
      hPara('first', { style: 'PSN' }) +
      '<text:section text:style-name="Sect1" text:name="Section1">' +
      hPara('in section') +
      '</text:section>' +
      hPara('after')
    const doc = pageDoc({
      body,
      layouts: [layoutXml('Mpm1', { columns: 2, numFormat: 'i' })],
      masterStyles: masterXml('Standard', 'Mpm1', { header: ['h'] }),
      contentExtra:
        '<style:style style:name="PSN" style:parent-style-name="Standard" style:master-page-name="Standard" style:family="paragraph"><style:paragraph-properties style:page-number="5"/></style:style>' +
        '<style:style style:name="Sect1" style:family="section"><style:section-properties><style:columns fo:column-count="3" fo:column-gap="0.300cm"/></style:section-properties></style:style>',
    })
    const bridge = await odtToBridge(await buildOdt(doc))
    const { sections } = await sectionsOf(bridge.docx)
    expect(sections).toHaveLength(3)
    expect(sections.map((s) => s.startType)).toEqual(['nextPage', 'continuous', 'continuous'])
    expect(sections.map((s) => s.settings.columns)).toEqual([2, 3, 2])
    expect(sections[0].pageNumberFmt).toBe('lowerRoman')
    expect(sections[0].pageNumberStart).toBe(5)
    expect(sections[1].pageNumberStart).toBeUndefined()
  })

  it('shows header page number fields as Word page fields', async () => {
    const field =
      '<text:p text:style-name="MP445_1"><text:span text:style-name="MT40">- <text:page-number text:select-page="current">7</text:page-number> -</text:span></text:p>'
    const doc = pageDoc({
      masterStyles: `<style:master-page style:name="Standard" style:page-layout-name="Mpm1"><style:footer>${field}</style:footer></style:master-page>`,
      body: hPara('only'),
      layouts: [layoutXml('Mpm1')],
    })
    const bridge = await odtToBridge(await buildOdt(doc))
    const { parsed } = await sectionsOf(bridge.docx)
    expect(parsed.footerText).toBe(`- ${PAGE_MARK} -`)
    expect(parsed.footerHasPageNumber).toBe(true)
  })

  it('handles the Hancom sample (several runs sharing a master page, a section, kept blocks)', async () => {
    const bridge = await odtToBridge(await buildOdt(hancomSample().options))
    const { sections } = await sectionsOf(bridge.docx)
    const ext = pageExtOf(bridge.map)
    expect(ext?.runs.map((r) => r.master)).toEqual(['Standard', 'MP2', 'Standard'])
    expect(sections.length).toBeGreaterThanOrEqual(3)
    expect(sections.filter((s) => s.startType === 'nextPage')).toHaveLength(3)
  })
})

describe('geometry', () => {
  const layouts = [
    layoutXml('A'),
    layoutXml('B', { margins: ['1.940cm', '1.950cm', '1.477cm', '2.117cm'], header: '1.058cm' }),
    layoutXml('C', {
      header: null,
      footer: null,
      margins: ['2.000cm', '2.000cm', '1.000cm', '2.000cm'],
    }),
    layoutXml('D', { header: '1.000cm', headerExtra: ' fo:margin-bottom="0.250cm"' }),
    layoutXml('E', { width: '29.699cm', height: '21.000cm', orientation: 'landscape' }),
  ]
  const lengthOf = (xml: string, attr: string, within?: string) => {
    const scope = within
      ? (xml.match(new RegExp(`<${within}>[\\s\\S]*?</${within}>`))?.[0] ?? '')
      : xml
    const value = new RegExp(`${attr}="([^"]*)"`).exec(scope)?.[1]
    return value === undefined ? 0 : cm(value)
  }

  it('page layout → sectPr → back gives the same ODF lengths (within rounding)', async () => {
    for (const layout of layouts) {
      const name = /style:name="([^"]*)"/.exec(layout)?.[1] as string
      const options = pageDoc({
        body: hPara('alpha', { style: 'PS1' }),
        layouts: [layout],
        masterStyles: masterXml('Standard', name, {}),
      })
      const bridge = await odtToBridge(await buildOdt(options))
      const { sections } = await sectionsOf(bridge.docx)
      const settings = sections[0].settings
      // a nudge of the left margin makes the save write the layout from the sectPr
      const { bytes } = await editorSave(
        bridge.docx,
        (blocks) => blocks.map((_, i) => ({ keep: i })),
        { section: { ...settings, marginLeft: settings.marginLeft + 20 } },
      )
      const back = await writeBack(bridge, bytes)
      const before = elementNamed(bridge.styles as string, 'style:page-layout', name) as string
      const after = elementNamed(back.styles, 'style:page-layout', name) as string
      expect(after, name).not.toBe(before)
      for (const [attr, within] of [
        ['fo:page-width'],
        ['fo:page-height'],
        ['fo:margin-top'],
        ['fo:margin-bottom'],
        ['svg:height', 'style:header-style'],
        ['svg:height', 'style:footer-style'],
      ] as const)
        expect(
          Math.abs(lengthOf(after, attr, within) - lengthOf(before, attr, within)),
          `${name} ${attr} ${within ?? ''}`,
        ).toBeLessThan(1)
    }
  })
})

describe('unedited round trip', () => {
  for (const [name, options] of [
    ['three runs', pageDoc()],
    ['hancom sample', hancomSample().options],
    [
      'first and left regions',
      singleRun({ header: ['h'], 'header-first': ['f'], 'header-left': ['l'], footer: ['x'] }),
    ],
  ] as const) {
    it(`writes nothing for ${name}`, async () => {
      const bridge = await odtToBridge(await buildOdt(options))
      const { bytes } = await editorSave(bridge.docx, (blocks) =>
        blocks.map((_, i) => ({ keep: i })),
      )
      const back = await writeBack(bridge, bytes)
      expect(back.content).toBe(bridge.content)
      expect(back.styles).toBe(bridge.styles)
      const out = await writeBack(bridge, bridge.docx)
      expect(out.content).toBe(bridge.content)
      expect(out.styles).toBe(bridge.styles)
    })
  }
})
