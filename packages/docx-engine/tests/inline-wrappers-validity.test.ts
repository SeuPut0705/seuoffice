import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { generateParagraphXml, parseDocx, saveDocx, type Run, type SaveBlock } from '../src/index'
import { buildDocx } from './helpers/build-docx'
import { buildWithHeader, count, genCtx, T } from './helpers/inline-wrap'

/**
 * Bytes carried on runs are written under an element the engine generates, in
 * a part whose root it may generate too. They are carried only when they can
 * be written there as well-formed XML, and bytes that did not come from the
 * parser (a co-editing peer's) are checked the same way before they are
 * written: the structure goes, the text stays.
 */

type Doc = Awaited<ReturnType<typeof parseDocx>>
const W15 = 'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"'
const W14 = 'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"'
const originals = (doc: Doc): SaveBlock[] =>
  doc.blocks.filter((b) => !b.hidden).map((b) => ({ kind: 'original', docxIndex: b.docxIndex! }))
const part = async (bytes: Uint8Array, path: string): Promise<string> =>
  (await JSZip.loadAsync(bytes)).file(path)!.async('string')
const bodyOf = (xml: string): string =>
  xml.slice(xml.indexOf('<w:body>') + 8, xml.lastIndexOf('<w:sectPr'))
const rebuilt = (runs: Run[]): string => generateParagraphXml({ type: 'paragraph', runs }, genCtx())

/** the prefixes a part uses in element and attribute names without declaring them anywhere */
function undeclaredPrefixes(xml: string): string[] {
  const declared = new Set(['xml', 'xmlns'])
  for (const m of xml.matchAll(/\sxmlns:([\w.-]+)\s*=/g)) declared.add(m[1])
  const used = new Set<string>()
  for (const tag of xml.matchAll(/<\/?([\w.-]+):[\w.-]+((?:"[^"]*"|'[^']*'|[^"'>])*)>/g)) {
    used.add(tag[1])
    for (const attr of tag[2].matchAll(/\s([\w.-]+):[\w.-]+\s*=\s*(?:"[^"]*"|'[^']*')/g))
      used.add(attr[1])
  }
  return [...used].filter((prefix) => !declared.has(prefix)).sort()
}

const APPEARANCE_PR =
  '<w:sdtPr><w:alias w:val="Title"/><w:id w:val="5"/><w15:appearance w15:val="hidden"/></w:sdtPr>'
const APPEARANCE = (inner: string) =>
  `<w:sdt>${APPEARANCE_PR}<w:sdtContent>${inner}</w:sdtContent></w:sdt>`

describe('a header rewritten as text declares the prefixes of what it carries', () => {
  const ROOT = `${W14} ${W15} xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14 w15"`
  const rewritten = async (headerXml: string, edit: boolean): Promise<string> => {
    const doc = await parseDocx(await buildWithHeader(headerXml, {}, ROOT))
    const paras = doc.headerParas!.map((p) => ({
      ...p,
      runs: p.runs.map((r) => (edit && r.text === ' end' ? { ...r, text: ' enD' } : r)),
    }))
    return part(
      await saveDocx(doc, originals(doc), { header: { text: '', paras } }),
      'word/header1.xml',
    )
  }
  const CONTROL = `<w:p>${T('Doc ')}${APPEARANCE(T('Annual report'))}${T(' end')}</w:p>`

  it.each([true, false])(
    'a control with a w15 property keeps it, and the new root declares w15 (text edited=%s)',
    async (edit) => {
      const xml = await rewritten(CONTROL, edit)
      expect(xml).toContain(APPEARANCE_PR)
      expect(undeclaredPrefixes(xml)).toEqual([])
      expect(/<w:hdr[^>]*>/.exec(xml)![0]).toContain(W15)
    },
  )

  it('a kept marker with a w14 attribute keeps it, and the new root declares w14', async () => {
    const marker = '<w:permStart w:id="1" w:edGrp="everyone" w14:x="1"/>'
    const xml = await rewritten(
      `<w:p>${marker}${T('free')}<w:permEnd w:id="1"/>${T(' end')}</w:p>`,
      true,
    )
    expect(xml).toContain(marker)
    expect(undeclaredPrefixes(xml)).toEqual([])
  })

  it('a header written into a document that has none: the control goes, its text stays', async () => {
    const source = await parseDocx(await buildWithHeader(CONTROL, {}, ROOT))
    const target = await parseDocx(await buildDocx({ bodyXml: `<w:p>${T('body')}</w:p>` }))
    const saved = await saveDocx(target, originals(target), {
      header: { text: '', paras: source.headerParas! },
    })
    const zip = await JSZip.loadAsync(saved)
    const path = Object.keys(zip.files).find((name) => /^word\/header\d*\.xml$/.test(name))!
    const xml = await zip.file(path)!.async('string')
    expect(xml).toContain('Annual report')
    expect(xml).not.toContain('w15:')
    expect(undeclaredPrefixes(xml)).toEqual([])
  })
})

describe('a wrapper whose prefixes the part root does not declare is not carried', () => {
  const reads = async (bodyXml: string, docRootExtraAttrs?: string): Promise<Run[]> =>
    (
      await parseDocx(
        await buildDocx({ bodyXml, ...(docRootExtraAttrs ? { docRootExtraAttrs } : {}) }),
      )
    ).blocks[0].runs!
  const carried = (runs: Run[]) => runs.filter((r) => r.wrap || r.opaqueXml !== undefined)

  it('declared on the paragraph only: the control reads and rebuilds as plain runs', async () => {
    const pr = '<w:sdtPr><w:id w:val="5"/><x1:meta x1:k="v"/></w:sdtPr>'
    const runs = await reads(
      `<w:p xmlns:x1="urn:x1">${T('a ')}<w:sdt>${pr}<w:sdtContent>${T('in')}</w:sdtContent></w:sdt>${T(' z')}</w:p>`,
    )
    expect(carried(runs)).toEqual([])
    expect(rebuilt(runs)).toBe(rebuilt(await reads(`<w:p>${T('a ')}${T('in')}${T(' z')}</w:p>`)))
  })

  it('declared on the paragraph only: the marker that uses it is not kept', async () => {
    const runs = await reads(
      `<w:p xmlns:x1="urn:x1">${T('a ')}<w:permStart w:id="1" x1:k="v"/>${T('in')}${T(' z')}</w:p>`,
    )
    expect(carried(runs)).toEqual([])
    expect(rebuilt(runs)).not.toContain('x1:')
  })

  it('declared nowhere in the part: not carried; declared on the root: carried byte for byte', async () => {
    const content = `<w:p>${T('a ')}${APPEARANCE(T('in'))}${T(' z')}</w:p>`
    expect(carried(await reads(content))).toEqual([])
    const runs = await reads(content, W15)
    expect(rebuilt(runs)).toBe(content)
  })

  it('declared on the wrapper itself: carried byte for byte', async () => {
    const content = `<w:p>${T('a ')}<w:sdt ${W15}>${APPEARANCE_PR}<w:sdtContent>${T('in')}</w:sdtContent></w:sdt>${T(' z')}</w:p>`
    expect(rebuilt(await reads(content))).toBe(content)
  })
})

describe('bytes on a run that did not come from the parser', () => {
  const CONTROL =
    '<w:sdt><w:sdtPr><w:id w:val="5"/></w:sdtPr><w:sdtContent>' +
    `${T('in')}</w:sdtContent></w:sdt>`
  const SOURCE = `<w:p>${T('a ')}${CONTROL}${T(' z')}</w:p><w:p>${T('tail')}</w:p>`
  const PLAIN = `<w:p>${T('a ')}${T('in')}${T(' z')}</w:p><w:p>${T('tail')}</w:p>`
  /** the first paragraph saved with `change` applied to its runs: the body, and the text it reopens as */
  const saved = async (
    change: (runs: Run[]) => unknown[],
  ): Promise<{ body: string; text: string }> => {
    const doc = await parseDocx(await buildDocx({ bodyXml: SOURCE }))
    const [first, tail] = doc.blocks.filter((b) => !b.hidden)
    const bytes = await saveDocx(doc, [
      {
        kind: 'generated',
        block: { type: 'paragraph', runs: change(first.runs!) as Run[] },
        docxIndex: first.docxIndex!,
      },
      { kind: 'original', docxIndex: tail.docxIndex! },
    ])
    const again = await parseDocx(bytes)
    return {
      body: bodyOf(again.internal.documentXml),
      text: again.blocks[0].runs!.map((r) => r.text).join(''),
    }
  }
  const withWrap = (wrap: unknown) => (runs: Run[]) =>
    runs.map((r) => (r.wrap ? { ...r, wrap: [wrap] } : r))
  const withOpaque = (opaqueXml: unknown) => (runs: Run[]) => [
    runs[0],
    { text: '', opaqueXml },
    ...runs.slice(1),
  ]
  const smart = (uri: string) => ({
    seq: 0,
    open: `<w:smartTag w:uri="${uri}" w:element="e">`,
    close: '</w:smartTag>',
  })
  const control = (open: string) => ({ seq: 0, open, close: '</w:sdtContent></w:sdt>' })

  const BAD_WRAPS: Array<[string, unknown]> = [
    ['a raw < in an attribute', smart('a<b')],
    ['a raw & in an attribute', smart('a&b')],
    ['an entity XML does not define', smart('&bogus;')],
    ['a character reference to a control character', smart('&#1;')],
    ['control characters in an attribute', smart('a\u0001b')],
    ['half a surrogate pair in an attribute', smart('a\ud800b')],
    [
      'the same attribute twice',
      { ...smart('u'), open: '<w:smartTag w:uri="u" w:uri="v" w:element="e">' },
    ],
    [
      'a prefix nothing declares',
      control('<w:sdt><w:sdtPr><zz:foo zz:a="1"/></w:sdtPr><w:sdtContent>'),
    ],
    [
      'the w prefix bound to another namespace',
      control('<w:sdt xmlns:w="urn:evil"><w:sdtPr/><w:sdtContent>'),
    ],
    [
      'a run inside the control properties',
      control('<w:sdt><w:sdtPr><w:r><w:t>HIDDEN</w:t></w:r></w:sdtPr><w:sdtContent>'),
    ],
    [
      'a run inside w:sdtEndPr',
      control('<w:sdt><w:sdtEndPr><w:r><w:t>HIDDEN</w:t></w:r></w:sdtEndPr><w:sdtContent>'),
    ],
    [
      'a section inside the control properties',
      control('<w:sdt><w:sdtPr><w:sectPr/></w:sdtPr><w:sdtContent>'),
    ],
    [
      'a run inside the smart tag properties',
      {
        seq: 0,
        open: '<w:smartTag w:uri="u" w:element="e"><w:smartTagPr><w:r><w:t>HIDDEN</w:t></w:r></w:smartTagPr>',
        close: '</w:smartTag>',
      },
    ],
    [
      'text inside the control properties',
      control('<w:sdt><w:sdtPr><w:alias>HIDDEN</w:alias></w:sdtPr><w:sdtContent>'),
    ],
    ['a comment in the shell', control('<w:sdt><w:sdtPr/><!-- note --><w:sdtContent>')],
    [
      'a sequence number that is not a number',
      {
        seq: {
          toJSON: () => {
            throw new Error('trap')
          },
        },
        open: '<w:bdo w:val="rtl">',
        close: '</w:bdo>',
      },
    ],
    ['bytes that are not strings', { seq: 0, open: 5, close: null }],
    ['a wrapper that is not an object', 'wrap'],
  ]
  it.each(BAD_WRAPS)('wrapper with %s: the text is written without it', async (_name, wrap) => {
    const { body, text } = await saved(withWrap(wrap))
    expect(text).toBe('a in z')
    expect(body).toBe(PLAIN)
  })

  it('a wrapper list that is not a list is read as no wrapper', async () => {
    const { body } = await saved((runs) => runs.map((r) => (r.wrap ? { ...r, wrap: 7 } : r)))
    expect(body).toBe(PLAIN)
  })

  it('odd but well-formed attribute values are written as they are', async () => {
    const wrap = {
      seq: 0,
      open: `<w:smartTag w:uri="a>b'c &amp; &#x41;" w:element='d"e>f'>`,
      close: '</w:smartTag>',
    }
    const { body, text } = await saved(withWrap(wrap))
    expect(text).toBe('a in z')
    expect(body).toContain(`${wrap.open}${T('in')}</w:smartTag>`)
  })

  const BAD_OPAQUE: Array<[string, unknown]> = [
    [
      'a control holding a table',
      '<w:sdt><w:sdtContent><w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl></w:sdtContent></w:sdt>',
    ],
    [
      'a control holding a section',
      '<w:sdt><w:sdtContent><w:sectPr><w:pgSz w:w="1" w:h="1"/></w:sectPr></w:sdtContent></w:sdt>',
    ],
    ['a control holding an empty paragraph', '<w:sdt><w:sdtContent><w:p/></w:sdtContent></w:sdt>'],
    [
      'a control holding a tracked insertion',
      '<w:smartTag w:uri="u" w:element="e"><w:ins w:id="1" w:author="x"/></w:smartTag>',
    ],
    ['a marker with a raw < in an attribute', '<w:permStart w:id="</w:p>"/>'],
    ['a marker with a raw & in an attribute', '<w:permStart w:id="a&b"/>'],
    ['a marker with a prefix the part does not declare', '<w:permStart w:id="1" zz:a="1"/>'],
    ['a marker holding an element', '<w:permStart w:id="1"><w:foo/></w:permStart>'],
    ['an element that is not kept', '<w:br w:type="page"/>'],
    ['a value that is not a string', 42],
    [
      'wrappers nested past any real document',
      `${'<w:bdo w:val="rtl">'.repeat(2000)}${'</w:bdo>'.repeat(2000)}`,
    ],
  ]
  it.each(BAD_OPAQUE)(
    'kept element that is %s: nothing of it is written',
    async (_name, opaqueXml) => {
      const { body, text } = await saved(withOpaque(opaqueXml))
      expect(text).toBe('a in z')
      expect(body).toBe(SOURCE)
    },
  )

  it('a kept element on a run that also holds text: the text is written', async () => {
    const { body, text } = await saved((runs) => [
      runs[0],
      { text: 'KEEP', opaqueXml: '<w:permStart w:id="1"/>' },
      ...runs.slice(1),
    ])
    expect(text).toBe('a KEEPin z')
    expect(count(body, 'KEEP')).toBe(1)
  })

  it('an empty control holding only empty controls and markers is written as it is', async () => {
    const whole =
      '<w:sdt><w:sdtPr><w:id w:val="8"/></w:sdtPr><w:sdtContent>' +
      '<w:smartTag w:uri="u" w:element="e"><w:permStart w:id="1" w:edGrp="everyone"/></w:smartTag>' +
      '<w:sdt><w:sdtPr><w:id w:val="9"/></w:sdtPr><w:sdtContent/></w:sdt></w:sdtContent></w:sdt>'
    const { body } = await saved(withOpaque(whole))
    expect(body).toContain(`${T('a ')}${whole}${CONTROL}`)
  })
})
