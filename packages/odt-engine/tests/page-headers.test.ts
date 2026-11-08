import { PAGE_MARK } from '@genoffice/docx-engine'
import { describe, expect, it } from 'vitest'
import { buildOdt } from './helpers/build-odt'
import { hCell, hFramedTable, hPara, hRow, hTable } from './helpers/hancom-fragments'
import { bodyOf, editorSave, replaceText } from './helpers/bridge'
import { editedHf, odtToPageBridge, pageWriteBack, sectionsOf } from './helpers/page-bridge'
import {
  elementNamed,
  hp,
  layoutXml,
  masterXml,
  namesOf,
  pageDoc,
  singleRun,
} from './helpers/page-fixtures'

const keepAll = (blocks: unknown[]) => blocks.map((_, i) => ({ keep: i }))

async function open(options = pageDoc()) {
  const bridge = await odtToPageBridge(await buildOdt(options))
  const view = await sectionsOf(bridge.docx)
  return { bridge, ...view }
}

/** Inner XML of one region of a master page. */
function region(styles: string, master: string, name: string): string | null {
  const m = elementNamed(styles, 'style:master-page', master)
  if (!m) return null
  const re = new RegExp(`<style:${name}(?:/>|>([\\s\\S]*?)</style:${name}>)`)
  const hit = re.exec(m)
  return hit ? (hit[1] ?? '') : null
}

describe('header objects the editor does not show', () => {
  // a Hancom header: a text paragraph and a paragraph holding only a framed table
  const framed = hFramedTable(hTable('Table9', 1, [hRow([hCell(hPara('logo'))])]), {
    anchor: 'paragraph',
  })
  const masters = (extra: string) =>
    masterXml('Standard', 'Mpm1', { header: ['header'], footer: ['footer'] }) +
    `<style:master-page style:name="MP2" style:page-layout-name="Mpm2"><style:header>${hp('header 2')}${extra}</style:header></style:master-page>`

  async function replaceHeader(extra: string) {
    const { bridge, parsed, sections } = await open(pageDoc({ masterStyles: masters(extra) }))
    const rId = sections[1].headerRefs.default as string
    // the CLI's set_header_footer: the whole header becomes one new paragraph
    const hf = editedHf(parsed, rId, (paras) => {
      replaceText(paras[0] as never, 0, 8, 'NEW')
      paras.splice(1)
    })
    const { bytes } = await editorSave(bridge.docx, keepAll, {
      sectionHf: [{ lastBlockIndex: sections[1].lastBlockIndex, kind: 'header', hf }],
    })
    const back = await pageWriteBack(bridge, bytes)
    return region(back.styles, 'MP2', 'header') as string
  }

  it('keeps a deleted paragraph that held only a framed table', async () => {
    const after = await replaceHeader(framed.paragraph)
    expect(after).toBe(hp('NEW') + framed.paragraph)
  })

  it('keeps the table of a deleted paragraph that had text too, without the text', async () => {
    const close = '</text:p>'
    const mixed = `${framed.paragraph.slice(0, -close.length)}<text:span text:style-name="MT40">gone</text:span>${close}`
    const after = await replaceHeader(mixed)
    expect(after).toContain(framed.frame)
    expect(after).not.toContain('gone')
    expect(after.startsWith(hp('NEW'))).toBe(true)
  })

  it('drops a deleted paragraph with nothing hidden in it', async () => {
    const after = await replaceHeader(hp('second'))
    expect(after).toBe(hp('NEW'))
  })
})

describe('header and footer edits', () => {
  it('rewrites only the edited region of an unshared master page', async () => {
    const { bridge, parsed, sections } = await open()
    const rId = sections[1].headerRefs.default as string
    const hf = editedHf(parsed, rId, (paras) => replaceText(paras[0] as never, 0, 6, 'HEADER'))
    const { bytes } = await editorSave(bridge.docx, keepAll, {
      sectionHf: [{ lastBlockIndex: sections[1].lastBlockIndex, kind: 'header', hf }],
    })
    const back = await pageWriteBack(bridge, bytes)
    expect(back.content).toBe(bridge.doc.contentXml)
    const before = bridge.doc.stylesXml as string
    const inner = region(before, 'MP2', 'header') as string
    const after = region(back.styles, 'MP2', 'header') as string
    expect(after).toBe(inner.replace('header 2', 'HEADER 2'))
    expect(back.styles.replace(after, inner)).toBe(before)
  })

  it('clones a shared master page when one run edited its header', async () => {
    const { bridge, parsed, sections } = await open()
    const rId = sections[0].headerRefs.default as string
    const hf = editedHf(parsed, rId, (paras) => replaceText(paras[0] as never, 0, 0, 'my '))
    const { bytes } = await editorSave(bridge.docx, keepAll, {
      sectionHf: [{ lastBlockIndex: sections[0].lastBlockIndex, kind: 'header', hf }],
    })
    const back = await pageWriteBack(bridge, bytes)
    expect(namesOf(back.styles, 'style:master-page')).toEqual(['Standard', 'Standard_io1', 'MP2'])
    expect(region(back.styles, 'Standard_io1', 'header')).toBe(hp('my header'))
    expect(region(back.styles, 'Standard_io1', 'footer')).toBe(hp('footer'))
    // the clone shares the unchanged page layout
    expect(elementNamed(back.styles, 'style:master-page', 'Standard_io1')).toContain(
      'style:page-layout-name="Mpm1"',
    )
    const before = bridge.doc.stylesXml as string
    expect(elementNamed(back.styles, 'style:master-page', 'Standard')).toBe(
      elementNamed(before, 'style:master-page', 'Standard'),
    )
    // run 1 points at the clone, run 3 keeps Standard
    expect(elementNamed(back.content, 'style:style', 'PS1')).toContain(
      'style:master-page-name="Standard_io1"',
    )
    expect(elementNamed(back.content, 'style:style', 'PS3')).toBe(
      elementNamed(bridge.doc.contentXml, 'style:style', 'PS3'),
    )
    expect(bodyOf(back.content)).toBe(bodyOf(bridge.doc.contentXml))
  })

  it('edits the final run header through the trailing options', async () => {
    const { bridge, parsed, sections } = await open(singleRun({ header: ['top', 'second'] }))
    const rId = sections[0].headerRefs.default as string
    const hf = editedHf(parsed, rId, (paras) => replaceText(paras[1] as never, 6, 6, '!'))
    const { bytes } = await editorSave(bridge.docx, keepAll, { header: hf })
    const back = await pageWriteBack(bridge, bytes)
    // the untouched first paragraph keeps its bytes
    expect(region(back.styles, 'Standard', 'header')).toBe(hp('top') + hp('second!'))
    expect(back.content).toBe(bridge.doc.contentXml)
  })

  it('adds a paragraph to a header', async () => {
    const { bridge, parsed, sections } = await open(singleRun({ header: ['top'] }))
    const rId = sections[0].headerRefs.default as string
    const hf = editedHf(parsed, rId, (paras) => {
      paras.push(
        JSON.parse(JSON.stringify({ ...paras[0], runs: [{ ...paras[0].runs[0], text: 'more' }] })),
      )
    })
    const { bytes } = await editorSave(bridge.docx, keepAll, { header: hf })
    const back = await pageWriteBack(bridge, bytes)
    const inner = region(back.styles, 'Standard', 'header') as string
    expect(inner.startsWith(hp('top'))).toBe(true)
    expect(inner).toContain('>more</text:span></text:p>')
    expect(inner.match(/<text:p /g)).toHaveLength(2)
  })

  it('turns a different first page on and off', async () => {
    // on: type a first-page header
    {
      const { bridge } = await open(singleRun({ header: ['plain'], footer: ['foot'] }))
      const { bytes } = await editorSave(bridge.docx, keepAll, {
        titlePg: true,
        headerFirst: { text: 'first', paras: [{ runs: [{ text: 'first' }] }] },
      })
      const back = await pageWriteBack(bridge, bytes)
      const inner = region(back.styles, 'Standard', 'header-first')
      expect(inner).toContain('>first<')
      // no first-page footer typed: the first page shows none
      expect(region(back.styles, 'Standard', 'footer-first')).toBe('')
      expect(region(back.styles, 'Standard', 'header')).toBe(hp('plain'))
      const m = elementNamed(back.styles, 'style:master-page', 'Standard') as string
      expect(m.indexOf('<style:header>')).toBeLessThan(m.indexOf('<style:header-first'))
      expect(m.indexOf('<style:header-first')).toBeLessThan(m.indexOf('<style:footer>'))
    }
    // off
    {
      const { bridge } = await open(
        singleRun({ header: ['plain'], 'header-first': ['first'], footer: ['foot'] }),
      )
      const { bytes } = await editorSave(bridge.docx, keepAll, { titlePg: false })
      const back = await pageWriteBack(bridge, bytes)
      expect(region(back.styles, 'Standard', 'header-first')).toBeNull()
      expect(region(back.styles, 'Standard', 'header')).toBe(hp('plain'))
    }
    // on, nothing typed: the first page shows the plain header in the editor too
    {
      const { bridge } = await open(singleRun({ header: ['plain'] }))
      const { sections } = await sectionsOf(bridge.docx)
      expect(sections[0].titlePg).toBe(false)
      const { bytes } = await editorSave(bridge.docx, keepAll, { titlePg: true })
      const back = await pageWriteBack(bridge, bytes)
      // Word shows an empty first-page header: so does the ODT
      expect(region(back.styles, 'Standard', 'header-first')).toBe('')
    }
  })

  it('turns different even pages on and off', async () => {
    {
      const { bridge } = await open(singleRun({ header: ['plain'] }))
      const { bytes } = await editorSave(bridge.docx, keepAll, {
        evenAndOddHeaders: true,
        headerEven: { text: 'even', paras: [{ runs: [{ text: 'even' }] }] },
      })
      const back = await pageWriteBack(bridge, bytes)
      expect(region(back.styles, 'Standard', 'header-left')).toContain('>even<')
      expect(region(back.styles, 'Standard', 'header')).toBe(hp('plain'))
    }
    {
      const { bridge } = await open(singleRun({ header: ['plain'], 'header-left': ['left'] }))
      const { parsed } = await sectionsOf(bridge.docx)
      expect(parsed.evenAndOddHeaders).toBe(true)
      const { bytes } = await editorSave(bridge.docx, keepAll, { evenAndOddHeaders: false })
      const back = await pageWriteBack(bridge, bytes)
      expect(region(back.styles, 'Standard', 'header-left')).toBeNull()
      expect(region(back.styles, 'Standard', 'header')).toBe(hp('plain'))
    }
  })

  it('keeps page number fields of an edited footer', async () => {
    const field =
      '<text:p text:style-name="MP445_1"><text:span text:style-name="MT40">page <text:page-number text:select-page="current" style:num-format="1">7</text:page-number></text:span></text:p>'
    const doc = pageDoc({
      body: hPara('only', { style: 'PS1' }),
      masterStyles: `<style:master-page style:name="Standard" style:page-layout-name="Mpm1"><style:footer>${field}</style:footer></style:master-page>`,
      layouts: [layoutXml('Mpm1')],
    })
    const { bridge, parsed, sections } = await open(doc)
    const rId = sections[sections.length - 1].footerRefs.default as string
    expect(parsed.hfParts?.[rId]?.text).toBe(`page ${PAGE_MARK}`)
    const hf = editedHf(parsed, rId, (paras) => replaceText(paras[0] as never, 0, 4, 'Page'))
    const { bytes } = await editorSave(bridge.docx, keepAll, { footer: hf })
    const back = await pageWriteBack(bridge, bytes)
    expect(region(back.styles, 'Standard', 'footer')).toBe(field.replace('>page ', '>Page '))
  })
})

describe('master pages without headers', () => {
  it('creates a header region typed into a run without one', async () => {
    const { bridge } = await open(singleRun({}, layoutXml('Mpm1')))
    const { bytes } = await editorSave(bridge.docx, keepAll, {
      header: { text: 'new', paras: [{ runs: [{ text: 'new' }] }] },
    })
    const back = await pageWriteBack(bridge, bytes)
    expect(region(back.styles, 'Standard', 'header')).toContain('>new<')
    expect(masterXml('Standard', 'Mpm1', {})).toContain('/>')
  })
})
