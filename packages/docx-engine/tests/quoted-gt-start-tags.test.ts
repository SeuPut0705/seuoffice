import { XMLValidator } from 'fast-xml-parser'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { parseDocx, saveDocx, type ParsedDocFull, type SaveBlock } from '../src/index'
import { TINY_PNG_BASE64, buildDocx } from './helpers/build-docx'

/**
 * XML allows `>` inside a quoted attribute value. A start tag read up to its
 * first `>` stops inside such a value; a part rewritten from that cut tag is
 * not well-formed, and Word refuses the file. Every case puts the `>` in a
 * root or section attribute the save reads and checks the saved part.
 */

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
/** a namespace whose URI holds the `>`: legal, and it sits before everything the save looks for */
const ODD = 'xmlns:x="urn:x>y"'
const BODY = '<w:p><w:r><w:t>Body</w:t></w:r></w:p>'

const partOf = async (bytes: Uint8Array, path: string) =>
  (await JSZip.loadAsync(bytes)).file(path)!.async('string')
const wellFormed = (xml: string) => expect(XMLValidator.validate(xml)).toBe(true)
const originalOrder = (doc: ParsedDocFull): SaveBlock[] =>
  doc.blocks
    .filter((b) => !b.hidden && b.docxIndex !== null)
    .map((b) => ({ kind: 'original', docxIndex: b.docxIndex! }))

/** a document whose default header is `inner` under a root that holds the quoted `>` */
function withOddHeader(inner: string) {
  return buildDocx({
    bodyXml: BODY,
    extraRels: `<Relationship Id="rId20" Type="${R_NS}/header" Target="header1.xml"/>`,
    sectPrExtra: '<w:headerReference w:type="default" r:id="rId20"/>',
    extraParts: [
      {
        path: 'word/header1.xml',
        xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${ODD} xmlns:w="${W_NS}" xmlns:r="${R_NS}">${inner}</w:hdr>`,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
      },
    ],
  })
}

const HEADER_TEXT = '<w:p><w:r><w:t>Old</w:t></w:r></w:p>'
const HEADER_TABLE =
  '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid>' +
  '<w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'

async function headerTextSaved(inner: string) {
  const doc = await parseDocx(await withOddHeader(inner))
  const para = doc.headerParas![0]!
  const saved = await saveDocx(doc, originalOrder(doc), {
    header: { text: 'New', paras: [{ ...para, runs: [{ text: 'New' }] }] },
  })
  return { saved, xml: await partOf(saved, 'word/header1.xml') }
}

describe('a start tag with a quoted > in an attribute value', () => {
  it('a text-only header is rewritten well-formed with the new text', async () => {
    const { saved, xml } = await headerTextSaved(HEADER_TEXT)
    wellFormed(xml)
    expect(
      (await parseDocx(saved)).headerParas!.map((p) => p.runs.map((r) => r.text).join('')),
    ).toEqual(['New'])
  })

  it('a header that keeps its root (it holds a table) keeps the root whole', async () => {
    const { xml } = await headerTextSaved(HEADER_TEXT + HEADER_TABLE)
    wellFormed(xml)
    expect(xml).toContain(`<w:hdr ${ODD} xmlns:w="${W_NS}"`)
    expect(xml).toContain('<w:t>Cell</w:t>')
    expect(xml).toContain('<w:t xml:space="preserve">New</w:t>')
  })

  it('a watermark-only change patches the header in place', async () => {
    const doc = await parseDocx(await withOddHeader(HEADER_TEXT + HEADER_TABLE))
    const saved = await saveDocx(doc, originalOrder(doc), { watermark: 'DRAFT' })
    const xml = await partOf(saved, 'word/header1.xml')
    wellFormed(xml)
    expect(xml).toContain(`<w:hdr ${ODD}`)
    expect((await parseDocx(saved)).watermarkText).toBe('DRAFT')
  })

  it('a page colour lands as the first child of a document root holding the quoted >', async () => {
    const doc = await parseDocx(await buildDocx({ bodyXml: BODY, docRootExtraAttrs: ODD }))
    const saved = await saveDocx(doc, originalOrder(doc), { pageColor: 'FF0000' })
    const xml = await partOf(saved, 'word/document.xml')
    wellFormed(xml)
    expect(xml).toMatch(
      /<w:document [^]*?xmlns:x="urn:x>y"[^"]*>\s*<w:background w:color="FF0000"\/>/,
    )
  })

  it('a hidden-from-AI mark extends the Ignorable list of that root instead of writing a second one', async () => {
    const doc = await parseDocx(
      await buildDocx({
        bodyXml: BODY,
        docRootExtraAttrs: `${ODD} xmlns:mc="${MC_NS}" mc:Ignorable="x"`,
      }),
    )
    const saved = await saveDocx(doc, [
      {
        kind: 'xml',
        xml: '<w:p><go:redact go:label="secret"><w:r><w:t>hidden</w:t></w:r></go:redact></w:p>',
      },
    ])
    const xml = await partOf(saved, 'word/document.xml')
    wellFormed(xml)
    expect(xml.match(/mc:Ignorable=/g)).toHaveLength(1)
    expect(xml).toMatch(/mc:Ignorable="x go"/)
  })

  it('a settings part written as one empty root takes the new flag inside the root', async () => {
    const doc = await parseDocx(
      await buildDocx({
        bodyXml: BODY,
        extraRels: `<Relationship Id="rId30" Type="${R_NS}/settings" Target="settings.xml"/>`,
        extraParts: [
          {
            path: 'word/settings.xml',
            xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="${W_NS}" ${ODD}/>`,
            contentType:
              'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
          },
        ],
      }),
    )
    const saved = await saveDocx(doc, originalOrder(doc), { evenAndOddHeaders: true })
    const xml = await partOf(saved, 'word/settings.xml')
    wellFormed(xml)
    expect(xml).toContain('<w:evenAndOddHeaders/>')
  })

  it('a picture watermark fits the page box of a page size holding the quoted >', async () => {
    const image = { base64: TINY_PNG_BASE64, mime: 'image/png' as const, widthPx: 96, heightPx: 48 }
    const widthOf = async (pgSz: string) => {
      const doc = await parseDocx(
        await buildDocx({
          bodyXml: BODY,
          docRootExtraAttrs: 'xmlns:x="urn:x"',
          sectPrXml: `<w:sectPr>${pgSz}<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`,
        }),
      )
      const saved = await saveDocx(doc, originalOrder(doc), { watermark: { image } })
      const header = (await JSZip.loadAsync(saved)).file(/^word\/header\d*\.xml$/)[0]!
      return /width:([\d.]+pt)/.exec(await header.async('string'))?.[1]
    }
    // A4 with 1in margins: the 2:1 image fits the 451.3pt margin width
    expect(await widthOf('<w:pgSz x:note="a>b" w:w="11906" w:h="16838"/>')).toBe('451.3pt')
  })
})
