/**
 * Text that reaches a PDF string in a save: a link address and a date field's format.
 * pdf-lib's `PDFString.of` writes its value raw, so a `)` in the value would close the
 * string and the rest would become PDF syntax (another action), and a trailing `\` would
 * swallow the closing parenthesis. It also writes each UTF-16 code unit as its low byte,
 * so a character above U+00FF can turn into `(`, `)` or `\`. The saved bytes are read
 * back and checked by structure, not by searching the text.
 */
import { describe, expect, it } from 'vitest'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { applySaveRequest } from '../src/main/save-pdf'
import type { DrawingInput, FormFieldInput, SavePdfRequest } from '../src/shared/ipc'

const LINK_PAYLOAD = 'https://a.example/) /Next << /S /JavaScript /JS (app.alert(1)) >> /Zz ('
/**
 * The review's payload, which the script's own `(` happens to balance, and one that closes
 * that `(` too and so ends the literal string before the fix
 */
const DATE_PAYLOADS = [
  'y) >> /Fo << /S /JavaScript /JS (app.alert(1)) >> /Zz << /JS (',
  ')) >> /Fo << /S /JavaScript /JS (app.alert(1)) >> /Zz << /JS ((',
]

async function save(over: Partial<SavePdfRequest>): Promise<PDFDocument> {
  const doc = await PDFDocument.create()
  doc.addPage([595, 842])
  const bytes = await doc.save({ useObjectStreams: false })
  const { bytes: saved } = await applySaveRequest(bytes, {
    path: '/tmp/literal.pdf',
    markups: [],
    drawings: [],
    formValues: [],
    stamps: [],
    ...over,
  })
  return PDFDocument.load(saved)
}

const link = (url: string): DrawingInput => ({
  kind: 'link',
  pageIndex: 0,
  rect: [10, 10, 200, 40],
  url,
})

const dateField = (dateFormat: string): FormFieldInput => ({
  name: 'd',
  kind: 'text',
  pageIndex: 0,
  rect: [10, 60, 200, 90],
  dateFormat,
})

/** Every dictionary of the file: indirect objects and the direct ones nested in them */
function dictionaries(pdf: PDFDocument): PDFDict[] {
  const found: PDFDict[] = []
  const walk = (value: unknown): void => {
    if (value instanceof PDFDict) {
      found.push(value)
      for (const [, child] of value.entries()) walk(child)
    } else if (value instanceof PDFArray) {
      for (const child of value.asArray()) walk(child)
    }
  }
  for (const [, object] of pdf.context.enumerateIndirectObjects()) walk(object)
  return found
}

const text = (value: unknown): string | undefined =>
  value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined

const keys = (dict: PDFDict): string[] =>
  dict
    .keys()
    .map((key) => key.asString())
    .sort()

/** The scripts of every JavaScript action in the file */
function scripts(pdf: PDFDocument): string[] {
  return dictionaries(pdf)
    .filter((dict) => dict.get(PDFName.of('S')) === PDFName.of('JavaScript'))
    .map((dict) => text(dict.get(PDFName.of('JS'))) ?? '<not a string>')
}

function linkAction(pdf: PDFDocument): PDFDict {
  const links = dictionaries(pdf).filter(
    (dict) => dict.get(PDFName.of('Subtype')) === PDFName.of('Link'),
  )
  expect(links).toHaveLength(1)
  return links[0]!.lookup(PDFName.of('A'), PDFDict)
}

describe('text in a literal string stays text', () => {
  for (const url of [
    LINK_PAYLOAD,
    'https://a.example/\\',
    'https://en.wikipedia.org/wiki/Mercury_(planet)',
    'https://a.example/(unbalanced',
  ]) {
    it(`a link to ${JSON.stringify(url)} is one URI action with exactly that address`, async () => {
      const pdf = await save({ drawings: [link(url)] })
      const action = linkAction(pdf)
      expect(keys(action)).toEqual(['/S', '/Type', '/URI'])
      expect(action.get(PDFName.of('S'))).toBe(PDFName.of('URI'))
      expect(text(action.get(PDFName.of('URI')))).toBe(url)
      expect(scripts(pdf)).toEqual([])
    })
  }

  // U+0128 and U+0129 are `(` and `)` once a code unit is cut to its low byte
  const WIDE_LINK_PAYLOAD =
    'https://a.example/\u0129 /Next << /S /JavaScript /JS \u0128app.alert\u01281\u0129\u0129 >> /Zz \u0128'
  for (const url of [WIDE_LINK_PAYLOAD, 'https://ko.wikipedia.org/wiki/대한민국?q=서울#역사']) {
    it(`a link to ${JSON.stringify(url)} is written as its ASCII address and opens as a link`, async () => {
      const href = new URL(url).href
      const pdf = await save({ drawings: [link(url)] })
      const action = linkAction(pdf)
      expect(keys(action)).toEqual(['/S', '/Type', '/URI'])
      expect(text(action.get(PDFName.of('URI')))).toBe(href)
      expect(scripts(pdf)).toEqual([])
      // what a viewer reads: pdf.js takes the annotation as a link to that address
      const viewer = await getDocument({ data: await pdf.save() }).promise
      const annots = await (await viewer.getPage(1)).getAnnotations()
      expect(annots.map((a: { subtype: string; url?: string }) => [a.subtype, a.url])).toEqual([
        ['Link', href],
      ])
    })
  }

  it('an address the URL parser refuses keeps its ASCII and percent-encodes the rest', async () => {
    const url = 'https://한 국/\u0129(x'
    expect(() => new URL(url)).toThrow()
    const action = linkAction(await save({ drawings: [link(url)] }))
    expect(keys(action)).toEqual(['/S', '/Type', '/URI'])
    expect(text(action.get(PDFName.of('URI')))).toBe('https://%ED%95%9C %EA%B5%AD/%C4%A9(x')
  })

  for (const format of [
    ...DATE_PAYLOADS,
    'yyyy年mm月dd日',
    'yyyy년 mm월 dd일',
    'm/d/yy h:MM tt',
    'dd.mm.yyyy',
    '\u0129\u0129 >> /Fo << /JS \u0128\u0128',
  ]) {
    it(`the date format ${JSON.stringify(format)} writes only the two date scripts`, async () => {
      const pdf = await save({ formFields: [dateField(format)] })
      const triggers = dictionaries(pdf).flatMap((dict) => {
        const aa = dict.lookupMaybe(PDFName.of('AA'), PDFDict)
        return aa ? [keys(aa)] : []
      })
      expect(triggers.length).toBeGreaterThan(0)
      for (const names of triggers) expect(names).toEqual(['/F', '/K'])
      const written = scripts(pdf)
      expect(written.length).toBe(triggers.length * 2)
      for (const script of written) {
        expect([`AFDate_FormatEx("${format}");`, `AFDate_KeystrokeEx("${format}");`]).toContain(
          script,
        )
      }
    })
  }

  it('an ordinary date format still writes the viewer scripts it always did', async () => {
    const pdf = await save({ formFields: [dateField('yyyy-mm-dd')] })
    expect(new Set(scripts(pdf))).toEqual(
      new Set(['AFDate_FormatEx("yyyy-mm-dd");', 'AFDate_KeystrokeEx("yyyy-mm-dd");']),
    )
  })
})
