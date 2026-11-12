/**
 * The hide-from-AI mark is the `<a:ext>` whose `uri` is ours. XML lets that attribute be written
 * with single quotes, with white space around `=`, or with the braces as references; another
 * producer may also close a list as `</a:extLst >`. All are the same mark: the reader (the
 * parser) finds it in every form, so the writer must too. A writer that does not see it keeps a
 * mark the user cleared, or writes a second one beside it.
 */
import { describe, expect, it } from 'vitest'
import { XMLValidator } from 'fast-xml-parser'
import { parseSlide, patchTextElementXml, setElementRedaction } from '../src/index'
import { hasRedactExtIn, REDACT_EL, REDACT_EXT_URI, REDACT_NS_WRITTEN } from '../src/redaction-xml'
import { attributeOf } from '../src/xml-utils'
import type { PictureElement, Slide, TextElement } from '../src/types'

const slideWith = (body: string) =>
  '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld>' +
  `<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${body}</p:spTree></p:cSld></p:sld>`

const SP = (rPr: string) =>
  '<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
  '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr>' +
  `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r>${rPr}<a:t>Call now</a:t></a:r></a:p></p:txBody></p:sp>`

const PIC = (spPrInner: string) =>
  '<p:pic><p:nvPicPr><p:cNvPr id="3" name="p"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
  '<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
  `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm>${spPrInner}</p:spPr></p:pic>`

const BRACED = REDACT_EXT_URI.replace('{', '&#123;').replace('}', '&#x7D;')

/** The mark as another producer may write it, under the given spelling of `uri="…"`. */
const FORMS: Array<[string, (label: string) => string]> = [
  [
    "uri='…'",
    (label) =>
      `<a:extLst><a:ext uri='${REDACT_EXT_URI}' xmlns:go='${REDACT_NS_WRITTEN}'><${REDACT_EL} label='${label}'/></a:ext></a:extLst>`,
  ],
  [
    'uri = "…"',
    (label) =>
      `<a:extLst><a:ext uri = "${REDACT_EXT_URI}" xmlns:go="${REDACT_NS_WRITTEN}"><${REDACT_EL} label="${label}"/></a:ext></a:extLst>`,
  ],
  [
    'uri="&#123;…&#x7D;"',
    (label) =>
      `<a:extLst><a:ext uri="${BRACED}" xmlns:go="${REDACT_NS_WRITTEN}"><${REDACT_EL} label="${label}"/></a:ext></a:extLst>`,
  ],
  [
    'a list closed as </a:extLst >',
    (label) =>
      `<a:extLst><a:ext uri="${REDACT_EXT_URI}" xmlns:go="${REDACT_NS_WRITTEN}"><${REDACT_EL} label="${label}"/></a:ext></a:extLst >`,
  ],
]

const load = (body: string): Slide =>
  parseSlide({ path: 'ppt/slides/slide1.xml', slideXml: slideWith(body), ctx: {} })

/** The labels of every mark in `xml`, each `<a:ext>` read by its decoded `uri`. */
function marksIn(xml: string): string[] {
  expect(XMLValidator.validate(slideWith(xml))).toBe(true)
  const out: string[] = []
  for (const ext of xml.matchAll(/<a:ext\b[^>]*>/g)) {
    if (attributeOf(ext[0], 'uri') !== REDACT_EXT_URI) continue
    const mark = new RegExp(`<${REDACT_EL}\\b[^>]*>`).exec(xml.slice(ext.index))![0]
    out.push(attributeOf(mark, 'label')!)
  }
  return out
}

/** How many extension lists `xml` holds. */
const listsIn = (xml: string) => xml.match(/<a:extLst\b/g)?.length ?? 0

describe.each(FORMS)('a mark written %s', (_form, mark) => {
  it('is seen', () => {
    expect(hasRedactExtIn(`<a:rPr lang="en-US">${mark('secret')}</a:rPr>`)).toBe(true)
  })

  describe('on a run', () => {
    const run = () => {
      const shape = load(SP(`<a:rPr lang="en-US">${mark('secret')}</a:rPr>`))
        .elements[0] as TextElement
      const r = shape.text!.paragraphs[0]!.runs[0]!
      expect(r.redact).toBe('secret')
      return { shape, r }
    }

    it('is kept, once, when the words are edited', () => {
      const { shape, r } = run()
      r.text = 'Call me'
      const out = patchTextElementXml(shape, shape.anchor.originalXml)
      expect(marksIn(out)).toEqual(['secret'])
      expect(listsIn(out)).toBe(1)
    })

    it('is replaced, not doubled, when it is renamed', () => {
      const { shape, r } = run()
      r.redact = 'phone'
      r.text = 'Call me'
      const out = patchTextElementXml(shape, shape.anchor.originalXml)
      expect(marksIn(out)).toEqual(['phone'])
      expect(listsIn(out)).toBe(1)
    })

    it('is gone when the user clears it', () => {
      const { shape, r } = run()
      delete r.redact
      r.text = 'Call me'
      const out = patchTextElementXml(shape, shape.anchor.originalXml)
      expect(marksIn(out)).toEqual([])
      const reread = load(out).elements[0] as TextElement
      expect(reread.text!.paragraphs[0]!.runs[0]!.redact).toBeUndefined()
    })
  })

  describe('on a picture', () => {
    const picture = () => {
      const slide = load(PIC(mark('photo')))
      const pic = slide.elements.find((e) => e.type === 'picture') as PictureElement
      expect(pic.redact).toBe('photo')
      return { slide, pic }
    }

    it('is replaced, not doubled, when it is renamed', () => {
      const { slide, pic } = picture()
      expect(setElementRedaction(slide, pic.id, 'face')).toBe(true)
      expect(marksIn(pic.anchor.originalXml)).toEqual(['face'])
      expect(listsIn(pic.anchor.originalXml)).toBe(1)
    })

    it('is gone when the user clears it', () => {
      const { slide, pic } = picture()
      expect(setElementRedaction(slide, pic.id, null)).toBe(true)
      expect(marksIn(pic.anchor.originalXml)).toEqual([])
      expect(listsIn(pic.anchor.originalXml)).toBe(0)
    })
  })
})
