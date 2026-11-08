import { beforeAll, describe, expect, it } from 'vitest'
import { parseDocx } from '@genoffice/docx-engine'
import {
  type OdtDocument,
  type OdtStyleTable,
  OoxmlToOdfContext,
  openOdt,
  readOdtStyles,
} from '../src/core'
import { odtToBridge } from './helpers/bridge'
import { buildContentXml, buildOdt, buildStylesXml } from './helpers/build-odt'
import { hParagraphAutoStyle } from './helpers/hancom-fragments'

let doc: OdtDocument
let styles: OdtStyleTable

beforeAll(async () => {
  doc = await openOdt(await buildOdt())
  styles = doc.styles
})

describe('style table: records', () => {
  it('keeps Hancom style names verbatim (spaces, non-ASCII, non-NCName)', () => {
    for (const name of ['바탕글', '바탕글 1', '+제목', '개요 1']) {
      const style = styles.common(name, 'paragraph')
      expect(style?.name).toBe(name)
      expect(style?.automatic).toBe(false)
      expect(style?.part).toBe('styles.xml')
    }
    expect(styles.common('바탕글 1', 'paragraph')?.displayName).toBe('바탕글 1')
  })

  it('decodes entity-escaped names while keeping the raw attribute text', async () => {
    const d = await openOdt(
      await buildOdt({
        extraCommonStyles:
          '<style:style style:name="&lt;그림&gt;" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/></style:style>',
      }),
    )
    const style = d.styles.common('<그림>', 'paragraph')
    expect(style?.rawName).toBe('&lt;그림&gt;')
  })

  it('distinguishes automatic styles of content.xml, automatic styles of styles.xml and common styles', () => {
    const contentP1 = styles.find('P1_0', 'paragraph', 'content')
    const stylesP1 = styles.find('P1_0', 'paragraph', 'styles')
    expect(contentP1?.automatic).toBe(true)
    expect(contentP1?.part).toBe('content.xml')
    expect(contentP1?.properties['style:paragraph-properties']['fo:text-align']).toBe('justify')
    expect(stylesP1?.automatic).toBe(true)
    expect(stylesP1?.part).toBe('styles.xml')
    expect(stylesP1?.properties['style:paragraph-properties']['fo:text-align']).toBe('right')
    // a common style is reachable from either scope
    expect(styles.find('바탕글', 'paragraph', 'content')?.automatic).toBe(false)
    expect(styles.find('바탕글', 'paragraph', 'styles')?.automatic).toBe(false)
    // families are separate name spaces
    expect(styles.find('P1_0', 'text', 'content')).toBeUndefined()
  })

  it('keeps Hancom paragraph attributes and the tab-stop list of each automatic style', () => {
    const p = styles.find('P1_0', 'paragraph', 'content')!
    const props = p.properties['style:paragraph-properties']
    expect(props['style:text-autospace']).toBe('none')
    expect(props['style:snap-to-layout-grid']).toBe('true')
    expect(p.tabStops).toEqual([
      { 'style:position': '14.993cm', 'style:type': 'right', 'style:leader-style': 'dotted' },
      { 'style:position': '15.500cm', 'style:type': 'right', 'style:leader-style': 'none' },
    ])
    expect(styles.find('P73_0', 'paragraph', 'content')!.tabStops).toBeNull()
  })

  it('records the master page a paragraph style starts', () => {
    expect(styles.find('P73_0_MS1_b3', 'paragraph', 'content')?.masterPageName).toBe('Standard')
    expect(styles.find('P270_172_MS2_b7', 'paragraph', 'content')?.masterPageName).toBe('MP2')
    // two sections share the Standard master page
    expect(styles.find('P5_0_MS3_b3', 'paragraph', 'content')?.masterPageName).toBe('Standard')
  })

  it('slices every style record exactly to its element source', () => {
    for (const style of styles.all) {
      const xml = style.part === 'content.xml' ? doc.contentXml : doc.stylesXml!
      const text = xml.slice(style.start, style.end)
      expect(text.startsWith(`<${style.tag}`)).toBe(true)
      expect(text.endsWith(style.selfClosing ? '/>' : `</${style.tag}>`)).toBe(true)
    }
    const p = styles.find('P73_0', 'paragraph', 'content')!
    expect(doc.contentXml.slice(p.start, p.end)).toBe(
      hParagraphAutoStyle('P73_0', { align: 'center' }),
    )
  })

  it('records the style containers so new automatic styles can be inserted', () => {
    const autos = styles.containers.content.automaticStyles!
    expect(doc.contentXml.slice(autos.start, autos.openEnd)).toBe('<office:automatic-styles>')
    expect(doc.contentXml.slice(autos.closeStart, autos.end)).toBe('</office:automatic-styles>')
    expect(styles.containers.styles.styles).toBeDefined()
    expect(styles.containers.styles.automaticStyles).toBeDefined()
    expect(styles.containers.styles.masterStyles).toBeDefined()
    expect(styles.containers.content.fontFaceDecls).toBeDefined()
  })
})

describe('style table: inheritance', () => {
  const common =
    '<style:default-style style:family="paragraph"><style:paragraph-properties fo:line-height="100%" fo:orphans="2"><style:tab-stops><style:tab-stop style:position="1cm"/></style:tab-stops></style:paragraph-properties><style:text-properties fo:font-size="10pt" fo:color="#000000"/></style:default-style>' +
    '<style:style style:name="Base" style:family="paragraph"><style:paragraph-properties fo:line-height="160%"/><style:text-properties fo:font-size="12pt"/></style:style>' +
    '<style:style style:name="Child Style" style:parent-style-name="Base" style:family="paragraph"><style:paragraph-properties fo:text-align="center"><style:tab-stops><style:tab-stop style:position="3cm" style:type="right"/></style:tab-stops></style:paragraph-properties></style:style>' +
    '<style:style style:name="Loop A" style:parent-style-name="Loop B" style:family="paragraph"/>' +
    '<style:style style:name="Loop B" style:parent-style-name="Loop A" style:family="paragraph"/>'
  const autos =
    '<style:style style:name="Child Style" style:family="paragraph"><style:paragraph-properties fo:text-align="end"/></style:style>' +
    '<style:style style:name="P1" style:parent-style-name="Child Style" style:family="paragraph"><style:text-properties fo:font-weight="bold"/></style:style>' +
    '<style:style style:name="P2" style:parent-style-name="Standard" style:family="paragraph"><style:paragraph-properties fo:margin-left="1cm"/></style:style>' +
    '<style:style style:name="P3" style:parent-style-name="Loop A" style:family="paragraph"/>'
  let table: OdtStyleTable

  beforeAll(() => {
    table = readOdtStyles(
      buildStylesXml({ commonStyles: common }),
      buildContentXml({ contentAutomaticStyles: autos }),
    )
  })

  it('merges default style, ancestors and the style itself, nearest wins', () => {
    const r = table.resolve('P1', 'paragraph', 'content')!
    expect(r.chain.map((s) => [s.name, s.automatic])).toEqual([
      ['P1', true],
      ['Child Style', false],
      ['Base', false],
    ])
    expect(r.defaultStyle?.kind).toBe('default-style')
    expect(r.properties['style:paragraph-properties']).toEqual({
      'fo:line-height': '160%',
      'fo:orphans': '2',
      'fo:text-align': 'center',
    })
    expect(r.properties['style:text-properties']).toEqual({
      'fo:font-size': '12pt',
      'fo:color': '#000000',
      'fo:font-weight': 'bold',
    })
    expect(r.missingParent).toBeNull()
  })

  it('never takes an automatic style as a parent', () => {
    // content.xml has an automatic "Child Style" too; the parent of P1 is the common one
    const r = table.resolve('P1', 'paragraph', 'content')!
    expect(r.chain[1].automatic).toBe(false)
    expect(r.properties['style:paragraph-properties']['fo:text-align']).toBe('center')
  })

  it('takes tab stops from the nearest style that defines them', () => {
    expect(table.resolve('P1', 'paragraph', 'content')!.tabStops).toEqual([
      { 'style:position': '3cm', 'style:type': 'right' },
    ])
    expect(table.resolve('Base', 'paragraph', 'content')!.tabStops).toEqual([
      { 'style:position': '1cm' },
    ])
  })

  it('tolerates a parent that does not exist (Hancom references an undefined Standard)', () => {
    const r = table.resolve('P2', 'paragraph', 'content')!
    expect(r.missingParent).toBe('Standard')
    expect(r.chain.map((s) => s.name)).toEqual(['P2'])
    expect(r.properties['style:paragraph-properties']).toEqual({
      'fo:line-height': '100%',
      'fo:orphans': '2',
      'fo:margin-left': '1cm',
    })
  })

  it('stops on inheritance cycles', () => {
    const r = table.resolve('P3', 'paragraph', 'content')!
    expect(r.chain.map((s) => s.name)).toEqual(['P3', 'Loop A', 'Loop B'])
  })

  it('returns undefined for an unknown style', () => {
    expect(table.resolve('nope', 'paragraph', 'content')).toBeUndefined()
  })
})

describe('style table: lists, page layouts and master pages', () => {
  it('records list styles with their levels', async () => {
    const d = await openOdt(
      await buildOdt({
        extraContentAutomaticStyles:
          '<text:list-style style:name="NL2"><text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix="."><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:margin-left="0.635cm"/></style:list-level-properties></text:list-level-style-number><text:list-level-style-bullet text:level="2" text:bullet-char="•"/></text:list-style>',
      }),
    )
    const list = d.styles.listStyle('NL2', 'content')!
    expect(list.automatic).toBe(true)
    expect(list.levels.map((l) => [l.level, l.kind])).toEqual([
      [1, 'number'],
      [2, 'bullet'],
    ])
    expect(list.levels[0].attrs['style:num-suffix']).toBe('.')
    expect(
      list.levels[0].properties['style:list-level-properties/style:list-level-label-alignment'],
    ).toEqual({ 'text:label-followed-by': 'listtab', 'fo:margin-left': '0.635cm' })
    expect(d.contentXml.slice(list.levels[1].start, list.levels[1].end)).toBe(
      '<text:list-level-style-bullet text:level="2" text:bullet-char="•"/>',
    )
  })

  it('records page layouts with their nested property elements', () => {
    const layout = styles.pageLayout('Mpm2')!
    expect(layout.properties['style:page-layout-properties']['style:print-orientation']).toBe(
      'landscape',
    )
    expect(
      layout.properties['style:header-style/style:header-footer-properties']['svg:height'],
    ).toBe('1.500cm')
  })

  it('records master pages with header/footer and left/first variants', () => {
    expect(styles.masterPages.map((m) => m.name)).toEqual(['Standard', 'MP2'])
    const standard = styles.masterPage('Standard')!
    expect(standard.pageLayoutName).toBe('Mpm1')
    expect(Object.keys(standard.regions)).toEqual(['header', 'footer'])
    const mp2 = styles.masterPage('MP2')!
    expect(Object.keys(mp2.regions)).toEqual(['header', 'header-left', 'footer-first'])
    const left = mp2.regions['header-left']!
    expect(doc.stylesXml!.slice(left.start, left.openEnd)).toBe('<style:header-left>')
    expect(doc.stylesXml!.slice(left.closeStart, left.end)).toBe('</style:header-left>')
    expect(
      doc.stylesXml!.slice(mp2.start, mp2.end).startsWith('<style:master-page style:name="MP2"'),
    ).toBe(true)
  })

  it('reads styles when styles.xml is missing', () => {
    const t = readOdtStyles(null, buildContentXml())
    expect(t.find('P1_0', 'paragraph', 'content')).toBeDefined()
    expect(t.masterPages).toEqual([])
  })
})

describe('derived style names', () => {
  it('are new, unused NCNames even when the original name is not one', async () => {
    const bridge = await odtToBridge(await buildOdt())
    const rctx = new OoxmlToOdfContext(
      bridge.doc,
      bridge.map,
      await parseDocx(bridge.docx),
      bridge.registry,
    )
    expect(rctx.allocateStyleName('P1_0')).toBe('P1_0_io1')
    expect(rctx.allocateStyleName('P1_0')).toBe('P1_0_io2')
    expect(rctx.allocateStyleName('P1_0_io1')).toBe('P1_0_io3')
    // Hancom names the 27th column `[`, and puts spaces in style names
    expect(rctx.allocateStyleName('Table2.[')).toBe('Table2.__io1')
    expect(rctx.allocateStyleName('바탕글 1')).toBe('바탕글_1_io1')
    expect(rctx.allocateStyleName('1st')).toBe('_1st_io1')
  })
})
