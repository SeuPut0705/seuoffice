import { describe, expect, it } from 'vitest'
import { buildOdt } from './helpers/build-odt'
import { hancomSample } from './helpers/hancom-sample'
import { bodyOf, editorSave } from './helpers/bridge'
import {
  keepAllBut,
  odtToPageBridge,
  pageWriteBack,
  sectPrRewrite,
  sectionsOf,
} from './helpers/page-bridge'
import { elementNamed, layoutXml, namesOf, pageDoc, singleRun } from './helpers/page-fixtures'

/** The original string with exactly the given element replaced (everything else must equal). */
function onlyChanged(before: string, after: string, element: string): void {
  const at = before.indexOf(element)
  expect(at).toBeGreaterThanOrEqual(0)
  expect(after.startsWith(before.slice(0, at))).toBe(true)
  expect(after.endsWith(before.slice(at + element.length))).toBe(true)
}

async function open(options = pageDoc()) {
  const bridge = await odtToPageBridge(await buildOdt(options))
  const view = await sectionsOf(bridge.docx)
  return { bridge, ...view }
}

describe('page setup edits', () => {
  it('a margin edit on a run with its own master page changes only its page layout', async () => {
    const { bridge, parsed, sections } = await open()
    const rewrite = sectPrRewrite(parsed, sections[1], {
      settings: { marginLeft: sections[1].settings.marginLeft + 567 },
    })
    const { bytes } = await editorSave(
      bridge.docx,
      keepAllBut({ [rewrite.docxIndex]: rewrite.xml }),
    )
    const back = await pageWriteBack(bridge, bytes)
    expect(back.content).toBe(bridge.doc.contentXml)
    const before = bridge.doc.stylesXml as string
    const layout = elementNamed(before, 'style:page-layout', 'Mpm2') as string
    onlyChanged(before, back.styles, layout)
    const edited = elementNamed(back.styles, 'style:page-layout', 'Mpm2') as string
    expect(edited).toContain('fo:margin-left="3.000cm"')
    expect(edited.replace('fo:margin-left="3.000cm"', 'fo:margin-left="2.000cm"')).toBe(layout)
  })

  it('a shared master page is cloned for the one run that changed; the others stay', async () => {
    const { bridge, sections } = await open()
    // the final run (Standard, shared with run 1): page size and margins
    const settings = {
      ...sections[2].settings,
      marginTop: sections[2].settings.marginTop + 567,
      pageHeight: 20000,
    }
    const { bytes } = await editorSave(
      bridge.docx,
      (blocks) => blocks.map((_, i) => ({ keep: i })),
      { section: settings },
    )
    const back = await pageWriteBack(bridge, bytes)
    const styles = back.styles
    expect(namesOf(styles, 'style:master-page')).toEqual(['Standard', 'Standard_io1', 'MP2'])
    const clone = elementNamed(styles, 'style:master-page', 'Standard_io1') as string
    expect(clone).toContain('style:page-layout-name="Mpm1_io1"')
    const layout = elementNamed(styles, 'style:page-layout', 'Mpm1_io1') as string
    expect(layout).toContain('fo:page-height="35.278cm"')
    // the top margin edit lands in the header length (the header distance is unchanged)
    expect(layout).toContain('svg:height="2.500cm"')
    expect(layout).toContain('fo:margin-top="1.000cm"')
    // originals untouched
    const original = bridge.doc.stylesXml as string
    for (const [el, name] of [
      ['style:master-page', 'Standard'],
      ['style:page-layout', 'Mpm1'],
      ['style:master-page', 'MP2'],
      ['style:page-layout', 'Mpm2'],
    ])
      expect(elementNamed(styles, el, name)).toBe(elementNamed(original, el, name))
    // the third run's start style now names the clone; the body is untouched
    expect(bodyOf(back.content)).toBe(bodyOf(bridge.doc.contentXml))
    expect(elementNamed(back.content, 'style:style', 'PS3')).toContain(
      'style:master-page-name="Standard_io1"',
    )
    expect(elementNamed(back.content, 'style:style', 'PS1')).toBe(
      elementNamed(bridge.doc.contentXml, 'style:style', 'PS1'),
    )
  })

  it('edits a shared master page in place when every run using it changed the same way', async () => {
    const { bridge, parsed, sections } = await open()
    const edit = { settings: { marginRight: sections[0].settings.marginRight + 567 } }
    const rewrite = sectPrRewrite(parsed, sections[0], edit)
    const { bytes } = await editorSave(
      bridge.docx,
      keepAllBut({ [rewrite.docxIndex]: rewrite.xml }),
      { section: { ...sections[2].settings, ...edit.settings } },
    )
    const back = await pageWriteBack(bridge, bytes)
    expect(back.content).toBe(bridge.doc.contentXml)
    const before = bridge.doc.stylesXml as string
    onlyChanged(before, back.styles, elementNamed(before, 'style:page-layout', 'Mpm1') as string)
    expect(elementNamed(back.styles, 'style:page-layout', 'Mpm1')).toContain(
      'fo:margin-right="3.000cm"',
    )
  })

  it('writes paper size and orientation', async () => {
    const { bridge, sections } = await open(singleRun({ header: ['h'] }))
    const s = sections[0].settings
    const { bytes } = await editorSave(
      bridge.docx,
      (blocks) => blocks.map((_, i) => ({ keep: i })),
      {
        section: {
          ...s,
          orientation: 'landscape',
          pageWidth: s.pageHeight,
          pageHeight: s.pageWidth,
        },
      },
    )
    const back = await pageWriteBack(bridge, bytes)
    const layout = elementNamed(back.styles, 'style:page-layout', 'Mpm1') as string
    expect(layout).toContain('fo:page-width="29.700cm"')
    expect(layout).toContain('fo:page-height="21.000cm"')
    expect(layout).toContain('style:print-orientation="landscape"')
  })

  it('writes page number format and start', async () => {
    const { bridge } = await open(singleRun({ header: ['h'] }))
    const { bytes } = await editorSave(
      bridge.docx,
      (blocks) => blocks.map((_, i) => ({ keep: i })),
      { pgNumType: { fmt: 'upperRoman', start: 3 } },
    )
    const back = await pageWriteBack(bridge, bytes)
    expect(elementNamed(back.styles, 'style:page-layout', 'Mpm1')).toContain('style:num-format="I"')
    expect(elementNamed(back.content, 'style:style', 'PS1')).toContain('style:page-number="3"')
    expect(bodyOf(back.content)).toBe(bodyOf(bridge.doc.contentXml))
  })

  it('never writes columns', async () => {
    const options = pageDoc({
      layouts: [layoutXml('Mpm1', { columns: 2 }), layoutXml('Mpm2')],
    })
    const { bridge, sections } = await open(options)
    expect(sections[2].settings.columns).toBe(2)
    const { bytes } = await editorSave(
      bridge.docx,
      (blocks) => blocks.map((_, i) => ({ keep: i })),
      { section: { ...sections[2].settings, columns: 1 } },
    )
    const back = await pageWriteBack(bridge, bytes)
    expect(back.styles).toBe(bridge.doc.stylesXml)
    expect(back.content).toBe(bridge.doc.contentXml)
  })

  it('the Hancom sample: an edit of the last run clones the master page it shares with the first', async () => {
    const { bridge, sections } = await open(hancomSample().options)
    const last = sections[sections.length - 1]
    const { bytes } = await editorSave(
      bridge.docx,
      (blocks) => blocks.map((_, i) => ({ keep: i })),
      { section: { ...last.settings, marginLeft: last.settings.marginLeft + 567 } },
    )
    const back = await pageWriteBack(bridge, bytes)
    expect(bodyOf(back.content)).toBe(bodyOf(bridge.doc.contentXml))
    expect(namesOf(back.styles, 'style:master-page')).toEqual(['Standard', 'Standard_io1', 'MP2'])
    const before = bridge.doc.stylesXml as string
    for (const name of ['Standard', 'MP2'])
      expect(elementNamed(back.styles, 'style:master-page', name)).toBe(
        elementNamed(before, 'style:master-page', name),
      )
    expect(elementNamed(back.content, 'style:style', 'P5_0_MS3_b3')).toContain(
      'style:master-page-name="Standard_io1"',
    )
    expect(elementNamed(back.content, 'style:style', 'P73_0_MS1_b3')).toBe(
      elementNamed(bridge.doc.contentXml, 'style:style', 'P73_0_MS1_b3'),
    )
  })
})
