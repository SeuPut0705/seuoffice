/**
 * A shape's durable id is the a16:creationId in the extension list of its own <p:cNvPr>. XML
 * lets another producer write that list empty with attributes (`<a:extLst xmlns:x="…" />`),
 * and the id, the extension's uri or the cNvPr id with single quotes or white space around `=`.
 * All are the same list and the same id: the reader finds them, and a rewrite neither adds a
 * second list (the schema allows one) nor a second creation id.
 * (Input from the Rust port's divergence ledger: cnvpr-own-extlst-forms #2.)
 */
import { describe, expect, it } from 'vitest'
import { XMLValidator } from 'fast-xml-parser'
import { createBlankPptx, copyElementData, openPptx, pasteElements, savePptx } from '../src/index'
import { elementDurableId, ensureCreationId, groupChildDurableId } from '../src/identity'
import type { SlideElement } from '../src/types'

const NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const GUID = '1A2B3C4D-0000-4000-8000-000000000000'
const URI = '{FF2B5EF4-FFF2-40B4-BE49-F238E27FC236}'
const A16 = 'http://schemas.microsoft.com/office/drawing/2014/main'

const shape = (cNvPr: string) =>
  `<p:sp ${NS}><p:nvSpPr>${cNvPr}<p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/>` +
  '<p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US"/><a:t>x</a:t></a:r></a:p></p:txBody></p:sp>'
/** A whole element around `originalXml`: the engine reads a model, not a partial one. */
const elementOf = (originalXml: string, nvId?: string): SlideElement => ({
  id: 'el',
  type: 'passthrough',
  kind: 'unknown',
  anchor: { spIndex: 0, originalXml, range: [0, originalXml.length] },
  transform: { offset: { x: 0, y: 0, cx: 0, cy: 0 }, rot: 0, flipH: false, flipV: false },
  ...(nvId === undefined ? {} : { nvId }),
})
const element = (xml: string) => elementOf(xml)

const listsIn = (xml: string) => xml.match(/<a:extLst\b/g)?.length ?? 0
const idsIn = (xml: string) => xml.match(/creationId\b/g)?.length ?? 0

/** The extension holding the creation id, in the forms another producer may write it. */
const CREATION: Array<[string, string]> = [
  [
    'as PowerPoint writes it',
    `<a:ext uri="${URI}"><a16:creationId xmlns:a16="${A16}" id="{${GUID}}"/></a:ext>`,
  ],
  [
    "with id='…'",
    `<a:ext uri="${URI}"><a16:creationId xmlns:a16="${A16}" id='{${GUID}}'/></a:ext>`,
  ],
  [
    'with id = "…"',
    `<a:ext uri="${URI}"><a16:creationId xmlns:a16="${A16}" id = "{${GUID}}"/></a:ext>`,
  ],
  [
    "with uri='…'",
    `<a:ext uri='${URI}'><a16:creationId xmlns:a16="${A16}" id="{${GUID}}"/></a:ext>`,
  ],
  [
    'under another prefix',
    `<a:ext uri="${URI}"><c16:creationId xmlns:c16="${A16}" id="{${GUID}}"/></a:ext>`,
  ],
]

describe('an empty extension list of cNvPr written with attributes', () => {
  it('takes the creation id, and stays the one list', () => {
    const el = element(
      shape(
        '<p:cNvPr id="18" name="O"><a:hlinkClick r:id=""/><a:extLst xmlns:x="urn:x" /></p:cNvPr>',
      ),
    )
    ensureCreationId(el)
    const xml = el.anchor.originalXml
    expect(XMLValidator.validate(xml)).toBe(true)
    expect(listsIn(xml)).toBe(1)
    expect(xml).toContain(`<a:extLst xmlns:x="urn:x" ><a:ext uri="${URI}">`)
    expect(elementDurableId(el)).toMatch(/^e_[0-9a-f]{8}$/)
  })
})

describe.each(CREATION)('a creation id %s', (_form, ext) => {
  const xml = shape(`<p:cNvPr id='7' name="Box"><a:extLst>${ext}</a:extLst></p:cNvPr>`)

  it('is the durable id', () => {
    expect(elementDurableId(element(xml))).toBe('e_1a2b3c4d')
  })

  it('is kept, once, when the shape is rewritten', () => {
    const el = element(xml)
    ensureCreationId(el)
    expect(el.anchor.originalXml).toBe(xml)
    expect(idsIn(el.anchor.originalXml)).toBe(1)
  })

  it('is the durable id of a group child', () => {
    const grp = element(
      `<p:grpSp ${NS}><p:nvGrpSpPr><p:cNvPr id="1" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${xml}</p:grpSp>`,
    )
    const child = elementOf('', '7')
    expect(groupChildDurableId(grp, child)).toBe('e_1a2b3c4d')
  })
})

it("a shape whose cNvPr id is written id='7' has the durable id e_7", () => {
  expect(elementDurableId(element(shape(`<p:cNvPr id='7' name="Box"/>`)))).toBe('e_7')
  expect(elementDurableId(element(shape(`<p:cNvPr id = "7" name="Box"/>`)))).toBe('e_7')
})

it.each(CREATION)(
  'a shape pasted beside itself, its creation id %s, gets a new one',
  async (_form, ext) => {
    const built = await openPptx(await createBlankPptx())
    const path = built.deck.slides[0]!.path
    const slideXml = built.archive.readText(path)!
    built.archive.entries.set(
      path,
      Buffer.from(
        slideXml.replace('</p:spTree>', () =>
          shape(`<p:cNvPr id="7" name="Box"><a:extLst>${ext}</a:extLst></p:cNvPr>`)
            .replace(` ${NS}`, '')
            .concat('</p:spTree>'),
        ),
        'utf8',
      ),
    )
    const opened = await openPptx(await savePptx(built))
    const slide = opened.deck.slides[0]!
    const source = slide.elements.find((e) => e.name === 'Box')!
    expect(elementDurableId(source)).toBe('e_1a2b3c4d')
    const pasted = pasteElements(opened, 0, [copyElementData(opened, slide, source)], {
      dx: 0,
      dy: 0,
    })!
    const copy = pasted.slide.elements.find((e) => e.id === pasted.elementIds[0]) as SlideElement
    expect(elementDurableId(copy)).toMatch(/^e_[0-9a-f]{8}$/)
    expect(elementDurableId(copy)).not.toBe('e_1a2b3c4d')
  },
)
