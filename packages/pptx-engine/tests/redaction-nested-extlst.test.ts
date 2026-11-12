import { describe, expect, it } from 'vitest'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import {
  addElement,
  createBlankPptx,
  openPptx,
  parseSlide,
  savePptx,
  setElementRedaction,
  type OpenedPptx,
} from '../src/index'
import {
  REDACT_EXT_URI,
  readRedactLabel,
  redactExtXml,
  setRedactExt,
  stripRedactExt,
} from '../src/redaction-xml'
import { relsPathFor } from '../src/zip'
import type { PictureElement, Slide, TextElement } from '../src/types'
import { pptxToText } from '../../file-parse/src/pptx'

/**
 * The reader looks for the hide-from-AI mark in the node's OWN <a:extLst> (its last child). The
 * writer used to put it in the first <a:extLst> it met, and a child can have one of its own:
 * PowerPoint gives <a:hlinkClick> a list for the hyperlink colour. On such a run the mark went
 * into the hyperlink's list, was never read back, and after save and reopen the words were no
 * longer withheld from the model.
 */

const LABEL = 'client phone'
const SECRET = '13800138000'

const HLINK =
  '<a:hlinkClick r:id="rId99"><a:extLst><a:ext uri="{A12FA001-AC4F-418D-AE19-62706E023703}">' +
  '<ahyp:hlinkClr xmlns:ahyp="http://schemas.microsoft.com/office/drawing/2018/hyperlinkcolor" val="tx"/>' +
  '</a:ext></a:extLst></a:hlinkClick>'
const LINK_RUN = `<a:r><a:rPr lang="en-US" dirty="0">${HLINK}</a:rPr><a:t>Call ${SECRET}</a:t></a:r>`

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: false,
  parseTagValue: false,
})
const labelOf = (xml: string, tag: string): string | undefined =>
  readRedactLabel(parser.parse(xml)[tag])

/** A deck whose one run is a hyperlink as PowerPoint writes it, with its own extension list. */
async function deckWithLinkRun(): Promise<Uint8Array> {
  const opened = await openPptx(await createBlankPptx())
  addElement(opened.deck.slides[0]!, {
    kind: 'textbox',
    offset: { x: 914400, y: 914400, cx: 3657600, cy: 914400 },
    paragraphs: [{ runs: [{ text: `Call ${SECRET}` }] }],
  })
  const written = await openPptx(await savePptx(opened))
  const path = written.deck.slides[0]!.path
  const put = (part: string, xml: string) =>
    written.archive.entries.set(part, Buffer.from(xml, 'utf8'))
  put(
    path,
    written.archive
      .readText(path)!
      .replace(/<a:r>(?:(?!<a:r>)[\s\S])*?<a:t>Call \d+<\/a:t><\/a:r>/, () => LINK_RUN),
  )
  put(
    relsPathFor(path),
    written.archive
      .readText(relsPathFor(path))!
      .replace(
        '</Relationships>',
        () =>
          '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/></Relationships>',
      ),
  )
  return savePptx(written)
}

function linkRun(opened: OpenedPptx) {
  const el = opened.deck.slides[0]!.elements.find(
    (e) => e.type === 'text' || e.type === 'shape',
  ) as TextElement
  return { el, run: el.text!.paragraphs[0]!.runs[0]! }
}

const slideXmlOf = (opened: OpenedPptx): string =>
  opened.archive.readText(opened.deck.slides[0]!.path)!

/** Mark the hyperlink run, save, and hand back the saved bytes. */
async function markedDeck(): Promise<Uint8Array> {
  const opened = await openPptx(await deckWithLinkRun())
  const { el, run } = linkRun(opened)
  expect(run.text).toBe(`Call ${SECRET}`)
  run.redact = LABEL
  el.dirty = true
  return savePptx(opened)
}

describe('withholding a hyperlink run whose <a:hlinkClick> has its own extLst', () => {
  it('the mark is still there after save and reopen, for the engine and for the text reader', async () => {
    const saved = await markedDeck()
    const reopened = await openPptx(saved)

    const xml = slideXmlOf(reopened)
    expect(XMLValidator.validate(xml)).toBe(true)
    // the engine's reader: the run is withheld, its words are still in the deck
    const { run } = linkRun(reopened)
    expect(run.redact).toBe(LABEL)
    expect(run.text).toBe(`Call ${SECRET}`)
    // the hyperlink's own list was not touched
    expect(xml).toContain(HLINK)
    // the reader other files use: the placeholder, never the words
    const text = await pptxToText(saved)
    expect(text).toContain(LABEL)
    expect(text).not.toContain(SECRET)
  })

  it('unmarking takes out our extension alone', async () => {
    const opened = await openPptx(await markedDeck())
    const { el, run } = linkRun(opened)
    delete run.redact
    el.dirty = true
    const reopened = await openPptx(await savePptx(opened))

    const xml = slideXmlOf(reopened)
    expect(XMLValidator.validate(xml)).toBe(true)
    expect(xml).not.toContain(REDACT_EXT_URI)
    expect(xml).toContain(LINK_RUN)
    expect(linkRun(reopened).run.redact).toBeUndefined()
    expect(await pptxToText(await savePptx(reopened))).toContain(SECRET)
  })
})

describe('the mark goes in the list the reader reads', () => {
  const OURS = redactExtXml(LABEL)
  const OTHER =
    '<a:ext uri="{OTHER}"><x:thing><a:extLst><a:ext uri="{DEEP}"/></a:extLst></x:thing></a:ext>'

  it('a node with a child list and no list of its own gains its own', () => {
    const out = setRedactExt(`<a:rPr lang="en-US">${HLINK}</a:rPr>`, LABEL)
    expect(out).toBe(`<a:rPr lang="en-US">${HLINK}<a:extLst>${OURS}</a:extLst></a:rPr>`)
    expect(labelOf(out, 'a:rPr')).toBe(LABEL)
    expect(stripRedactExt(out)).toBe(`<a:rPr lang="en-US">${HLINK}</a:rPr>`)
  })

  it('a node with a child list and its own list gets the mark in its own', () => {
    const own = (inner: string) => `<a:extLst x:keep="1">${inner}</a:extLst>`
    const start = `<a:rPr lang="en-US">${HLINK}${own(OTHER)}</a:rPr>`
    const out = setRedactExt(start, LABEL)
    expect(out).toBe(`<a:rPr lang="en-US">${HLINK}${own(OTHER + OURS)}</a:rPr>`)
    expect(labelOf(out, 'a:rPr')).toBe(LABEL)
    expect(stripRedactExt(out)).toBe(start)
  })

  it('a self-closing own list after a child list is the one that opens', () => {
    const out = setRedactExt(`<a:rPr lang="en-US">${HLINK}<a:extLst/></a:rPr>`, LABEL)
    expect(out).toBe(`<a:rPr lang="en-US">${HLINK}<a:extLst>${OURS}</a:extLst></a:rPr>`)
    expect(labelOf(out, 'a:rPr')).toBe(LABEL)
  })

  it('a mark an earlier version left in a child list is moved to the own list', () => {
    const stray = HLINK.replace('</a:ext></a:extLst>', () => `</a:ext>${OURS}</a:extLst>`)
    const out = setRedactExt(`<a:rPr lang="en-US">${stray}</a:rPr>`, 'new label')
    expect(out).toBe(
      `<a:rPr lang="en-US">${HLINK}<a:extLst>${redactExtXml('new label')}</a:extLst></a:rPr>`,
    )
    expect(labelOf(out, 'a:rPr')).toBe('new label')
    // and clearing such a deck takes the stray out, leaving the hyperlink's list as it was
    expect(stripRedactExt(`<a:rPr lang="en-US">${stray}</a:rPr>`)).toBe(
      `<a:rPr lang="en-US">${HLINK}</a:rPr>`,
    )
  })

  it('a node whose own list is not its last child still gets a mark that is read back', () => {
    const misordered =
      '<a:rPr lang="en-US"><a:extLst><a:ext uri="{OTHER}"/></a:extLst><a:latin typeface="Calibri"/></a:rPr>'
    const out = setRedactExt(misordered, LABEL)
    expect(XMLValidator.validate(out)).toBe(true)
    expect(labelOf(out, 'a:rPr')).toBe(LABEL)
    expect(stripRedactExt(out)).toBe(misordered)
  })

  it('a mark in the second of two own lists is read', () => {
    const twoLists = `<a:rPr lang="en-US"><a:extLst><a:ext uri="{OTHER}"/></a:extLst><a:extLst>${OURS}</a:extLst></a:rPr>`
    expect(labelOf(twoLists, 'a:rPr')).toBe(LABEL)
  })
})

describe('withholding a picture whose spPr has a child with its own extLst', () => {
  const LN =
    '<a:ln w="9525"><a:noFill/><a:extLst><a:ext uri="{LINE}"><x:l/></a:ext></a:extLst></a:ln>'
  const spPr = (tail: string) =>
    '<p:spPr><a:xfrm><a:off x="100000" y="1000000"/><a:ext cx="2000000" cy="1500000"/></a:xfrm>' +
    `<a:prstGeom prst="rect"/>${LN}${tail}</p:spPr>`
  const pic = (props: string) =>
    '<p:pic><p:nvPicPr><p:cNvPr id="3" name="p"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr></p:nvPicPr>' +
    `<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>${props}</p:pic>`
  const load = (body: string) =>
    parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml:
        '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r" xmlns:x="x"><p:cSld>' +
        `<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${body}</p:spTree></p:cSld></p:sld>`,
      ctx: {},
    })
  const picOf = (s: Slide) => s.elements.find((e) => e.type === 'picture') as PictureElement

  it('the mark is read back, and clearing it gives the picture its bytes back', () => {
    const start = pic(spPr(''))
    const slide = load(start)
    expect(setElementRedaction(slide, picOf(slide).id, LABEL)).toBe(true)
    const marked = picOf(slide).anchor.originalXml
    expect(marked).toBe(pic(spPr(`<a:extLst>${redactExtXml(LABEL)}</a:extLst>`)))
    expect(picOf(load(marked)).redact).toBe(LABEL)

    const again = load(marked)
    expect(setElementRedaction(again, picOf(again).id, null)).toBe(true)
    expect(picOf(again).anchor.originalXml).toBe(start)
    expect(picOf(load(picOf(again).anchor.originalXml)).redact).toBeUndefined()
  })
})
