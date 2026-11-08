import { describe, expect, it } from 'vitest'
import { stripParagraphSectPr } from '../src/page'
import { buildOdt } from './helpers/build-odt'
import { bodyOf, editorSave, replaceText } from './helpers/bridge'
import {
  keepAllBut,
  odtToPageBridge,
  pageWriteBack,
  sectPrRewrite,
  sectionsOf,
} from './helpers/page-bridge'
import { elementNamed, namesOf, pageDoc } from './helpers/page-fixtures'

async function open(options = pageDoc()) {
  const bridge = await odtToPageBridge(await buildOdt(options))
  const view = await sectionsOf(bridge.docx)
  return { bridge, ...view }
}

/** The automatic style of the paragraph holding `text` in a content.xml. */
function styleOfParagraph(content: string, text: string): string | null {
  const re = new RegExp(
    `<text:p text:style-name="([^"]*)"><text:span[^>]*>${text}</text:span></text:p>`,
  )
  return re.exec(content)?.[1] ?? null
}

describe('section breaks', () => {
  it('a break added in the editor starts a new master page cloned from the current one', async () => {
    const { bridge, visible, sections } = await open()
    // the editor inserts `<w:p><w:pPr>{current sectPr}</w:pPr></w:p>` after "one a"
    const breakXml = `<w:p><w:pPr>${sections[0].sectPrXml}</w:pPr></w:p>`
    const { bytes } = await editorSave(bridge.docx, (blocks) => [
      { keep: 0 },
      { xml: breakXml },
      ...blocks.slice(1).map((_, i) => ({ keep: i + 1 })),
    ])
    expect(visible.length).toBe(6)
    const { sections: after } = await sectionsOf(bytes)
    expect(after).toHaveLength(4)
    const back = await pageWriteBack(bridge, bytes)
    expect(namesOf(back.styles, 'style:master-page')).toEqual(['Standard', 'Standard_io1', 'MP2'])
    // the clone is a copy of Standard under the new name
    const clone = elementNamed(back.styles, 'style:master-page', 'Standard_io1') as string
    const original = elementNamed(bridge.doc.stylesXml as string, 'style:master-page', 'Standard')
    expect(clone.replace('Standard_io1', 'Standard')).toBe(original)
    // "one b" now starts a page run under the clone; nothing else in the body changed
    const style = styleOfParagraph(back.content, 'one b') as string
    expect(style).not.toBe('P1_0')
    const def = elementNamed(back.content, 'style:style', style) as string
    expect(def).toContain('style:master-page-name="Standard_io1"')
    expect(def.replace(/ style:master-page-name="[^"]*"/, '').replace(style, 'P1_0')).toBe(
      elementNamed(bridge.doc.contentXml, 'style:style', 'P1_0'),
    )
    expect(
      bodyOf(back.content).replace(`text:style-name="${style}"`, 'text:style-name="P1_0"'),
    ).toBe(bodyOf(bridge.doc.contentXml))
    // no empty paragraph for the break itself
    expect(back.content.match(/<text:p /g)?.length).toBe(
      bridge.doc.contentXml.match(/<text:p /g)?.length,
    )
  })

  it('a removed break merges the run into the previous one', async () => {
    const { bridge, parsed, sections } = await open()
    // the editor drops the sectPr that ends section 1 (carried by "one b")
    const carrier = parsed.blocks.find((b) => b.docxIndex === sections[0].lastBlockIndex)
    const xml = stripParagraphSectPr(carrier?.originalXml as string)
    const { bytes } = await editorSave(bridge.docx, (blocks) =>
      blocks.map((b, i) =>
        b.docxIndex === sections[0].lastBlockIndex ? { xml, docxIndex: b.docxIndex } : { keep: i },
      ),
    )
    const back = await pageWriteBack(bridge, bytes)
    // run 2 ("two a", PS2 → MP2) now follows run 1's master page: PS2 loses its switch
    expect(bodyOf(back.content)).toBe(bodyOf(bridge.doc.contentXml))
    const ps2 = elementNamed(back.content, 'style:style', 'PS2') as string
    expect(ps2).toBe(
      elementNamed(bridge.doc.contentXml, 'style:style', 'PS2')?.replace(
        ' style:master-page-name="MP2"',
        '',
      ),
    )
    // run 1's master page and everything in styles.xml is untouched
    expect(back.styles).toBe(bridge.doc.stylesXml)
  })

  it('a text edit in a paragraph carrying a section break is a plain text edit', async () => {
    const { bridge, parsed, sections } = await open()
    const index = sections[0].lastBlockIndex
    const { bytes } = await editorSave(bridge.docx, (blocks) =>
      blocks.map((b, i) =>
        b.docxIndex === index
          ? { edit: i, change: (g) => replaceText(g, 0, 3, 'ONE') }
          : { keep: i },
      ),
    )
    expect(parsed.blocks.some((b) => b.docxIndex === index)).toBe(true)
    const back = await pageWriteBack(bridge, bytes)
    expect(back.styles).toBe(bridge.doc.stylesXml)
    expect(bodyOf(back.content)).toBe(bodyOf(bridge.doc.contentXml).replace('>one b<', '>ONE b<'))
  })

  it('a page setup edit together with a text edit in the same section', async () => {
    const { bridge, sections } = await open()
    const index = sections[1].lastBlockIndex
    // the text edit regenerates the paragraph (its rawPPr keeps the sectPr) …
    const first = await editorSave(bridge.docx, (blocks) =>
      blocks.map((b, i) =>
        b.docxIndex === index
          ? { edit: i, change: (g) => replaceText(g, 0, 0, '>> ') }
          : { keep: i },
      ),
    )
    // … and the page setup edit rewrites that sectPr (apps/docs applySectPrRewrites)
    const mid = await sectionsOf(first.bytes)
    const rewrite = sectPrRewrite(mid.parsed, mid.sections[1], { settings: { marginLeft: 1701 } })
    const { bytes } = await editorSave(
      first.bytes,
      keepAllBut({ [rewrite.docxIndex]: rewrite.xml }),
    )
    const back = await pageWriteBack(bridge, bytes)
    expect(elementNamed(back.styles, 'style:page-layout', 'Mpm2')).toContain(
      'fo:margin-left="3.000cm"',
    )
    expect(back.content).toContain('&gt;&gt; two b')
    // the paragraph kept its style (its format did not change)
    expect(styleOfParagraph(back.content, '&gt;&gt; two b')).toBe('P1_0')
  })

  it('a break added before an edited paragraph re-styles the edited paragraph', async () => {
    const { bridge, sections } = await open()
    const breakXml = `<w:p><w:pPr>${sections[0].sectPrXml}</w:pPr></w:p>`
    const { bytes } = await editorSave(bridge.docx, (blocks) => [
      { keep: 0 },
      { xml: breakXml },
      { edit: 1, change: (g) => replaceText(g, 0, 0, 'new ') },
      ...blocks.slice(2).map((_, i) => ({ keep: i + 2 })),
    ])
    const back = await pageWriteBack(bridge, bytes)
    const style = styleOfParagraph(back.content, 'new one b') as string
    expect(elementNamed(back.content, 'style:style', style)).toContain(
      'style:master-page-name="Standard_io1"',
    )
    expect(namesOf(back.styles, 'style:master-page')).toContain('Standard_io1')
  })

  it('a removed break whose start style is shared re-styles only that paragraph', async () => {
    // "two a" starts MP2 with a style that another paragraph also uses
    const body = pageDoc().body?.replace(
      '<text:p text:style-name="P1_0"><text:span text:style-name="T1">three b',
      '<text:p text:style-name="PS2"><text:span text:style-name="T1">three b',
    )
    const options = { ...pageDoc(), body }
    const { bridge, parsed, sections } = await open(options)
    expect(sections).toHaveLength(4)
    const carrier = parsed.blocks.find((b) => b.docxIndex === sections[0].lastBlockIndex)
    const xml = stripParagraphSectPr(carrier?.originalXml as string)
    const { bytes } = await editorSave(bridge.docx, (blocks) =>
      blocks.map((b, i) =>
        b.docxIndex === sections[0].lastBlockIndex ? { xml, docxIndex: b.docxIndex } : { keep: i },
      ),
    )
    const back = await pageWriteBack(bridge, bytes)
    expect(elementNamed(back.content, 'style:style', 'PS2')).toBe(
      elementNamed(bridge.doc.contentXml, 'style:style', 'PS2'),
    )
    const style = styleOfParagraph(back.content, 'two a') as string
    expect(style).not.toBe('PS2')
    expect(elementNamed(back.content, 'style:style', style)).not.toContain('master-page-name')
    expect(styleOfParagraph(back.content, 'three b')).toBe('PS2')
  })

  it('a deleted run-start paragraph hands the switch to the next paragraph', async () => {
    const { bridge } = await open()
    // delete "two a" (the paragraph whose style switches to MP2), keep the break
    const { bytes } = await editorSave(bridge.docx, (blocks) =>
      blocks.map((_, i) => ({ keep: i })).filter((_, i) => i !== 2),
    )
    const back = await pageWriteBack(bridge, bytes)
    expect(back.content).not.toContain('two a')
    const style = styleOfParagraph(back.content, 'two b') as string
    expect(elementNamed(back.content, 'style:style', style)).toContain(
      'style:master-page-name="MP2"',
    )
    expect(back.styles).toBe(bridge.doc.stylesXml)
  })

  it('a page number start on a run without an explicit start paragraph', async () => {
    const options = pageDoc({
      body: '<text:p text:style-name="P1_0"><text:span text:style-name="T1">plain</text:span></text:p>',
    })
    const { bridge } = await open(options)
    const { bytes } = await editorSave(
      bridge.docx,
      (blocks) => blocks.map((_, i) => ({ keep: i })),
      { pgNumType: { start: 4 } },
    )
    const back = await pageWriteBack(bridge, bytes)
    const style = styleOfParagraph(back.content, 'plain') as string
    const def = elementNamed(back.content, 'style:style', style) as string
    expect(def).toContain('style:master-page-name="Standard"')
    expect(def).toContain('style:page-number="4"')
  })

  it('two runs sharing a master page changed differently get one clone', async () => {
    const { bridge, parsed, sections } = await open()
    const rewrite = sectPrRewrite(parsed, sections[0], { settings: { marginLeft: 1701 } })
    const { bytes } = await editorSave(
      bridge.docx,
      keepAllBut({ [rewrite.docxIndex]: rewrite.xml }),
      { section: { ...sections[2].settings, marginRight: 1701 } },
    )
    const back = await pageWriteBack(bridge, bytes)
    expect(namesOf(back.styles, 'style:master-page')).toEqual(['Standard', 'Standard_io1', 'MP2'])
    expect(namesOf(back.styles, 'style:page-layout')).toEqual(['Mpm1', 'Mpm2', 'Mpm1_io1'])
    const layoutOf = (master: string) =>
      /style:page-layout-name="([^"]*)"/.exec(
        elementNamed(back.styles, 'style:master-page', master) as string,
      )?.[1] as string
    expect(elementNamed(back.styles, 'style:page-layout', layoutOf('Standard'))).toContain(
      'fo:margin-left="3.000cm"',
    )
    expect(elementNamed(back.styles, 'style:page-layout', layoutOf('Standard_io1'))).toContain(
      'fo:margin-right="3.000cm"',
    )
    expect(elementNamed(back.content, 'style:style', 'PS3')).toContain(
      'style:master-page-name="Standard_io1"',
    )
  })
})
