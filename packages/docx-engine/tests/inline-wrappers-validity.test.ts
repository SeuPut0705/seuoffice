import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { generateParagraphXml, parseDocx, saveDocx, type Run, type SaveBlock } from '../src/index'
import { buildDocx } from './helpers/build-docx'
import { buildWithHeader, genCtx, skeleton, T } from './helpers/inline-wrap'

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

describe('a header rewritten as text is written under a root the engine generates', () => {
  const ROOT = `${W14} ${W15} xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14 w15"`
  const rewritten = async (headerXml: string, edit: boolean): Promise<string> => {
    const doc = await parseDocx(await buildWithHeader(headerXml, {}, ROOT))
    const paras = doc.headerParas!.map((p) => ({
      ...p,
      runs: p.runs.map((r) =>
        edit && r.text.endsWith(' end') ? { ...r, text: r.text.replace(/ end$/, ' enD') } : r,
      ),
    }))
    return part(
      await saveDocx(doc, originals(doc), { header: { text: '', paras } }),
      'word/header1.xml',
    )
  }
  const CONTROL = `<w:p>${T('Doc ')}${APPEARANCE(T('Annual report'))}${T(' end')}</w:p>`
  const PLAIN_PR = '<w:sdtPr><w:alias w:val="Title"/><w:id w:val="5"/></w:sdtPr>'

  it.each([true, false])(
    'a control with a w15 property is not carried: the header reads and is rewritten as the same header without it (text edited=%s)',
    async (edit) => {
      const doc = await parseDocx(await buildWithHeader(CONTROL, {}, ROOT))
      expect(doc.headerParas!.flatMap((p) => p.runs).filter((r) => r.wrap)).toEqual([])
      const xml = await rewritten(CONTROL, edit)
      expect(skeleton(xml)).toContain(`[Doc Annual report en${edit ? 'D' : 'd'}]`)
      expect(xml).toBe(
        await rewritten(`<w:p>${T('Doc ')}${T('Annual report')}${T(' end')}</w:p>`, edit),
      )
      expect(undeclaredPrefixes(xml)).toEqual([])
    },
  )

  it('a wrapper a peer put on a run of such a header is written as its text', async () => {
    const doc = await parseDocx(
      await buildWithHeader(
        `<w:p>${T('Doc ')}${T('Annual report', '<w:rPr><w:b/></w:rPr>')}</w:p>`,
        {},
        ROOT,
      ),
    )
    const wrap = [
      { seq: 0, open: `<w:sdt>${APPEARANCE_PR}<w:sdtContent>`, close: '</w:sdtContent></w:sdt>' },
    ]
    const paras = doc.headerParas!.map((p) => ({
      ...p,
      runs: p.runs.map((r) => (r.text === 'Annual report' ? { ...r, wrap } : r)),
    }))
    const xml = await part(
      await saveDocx(doc, originals(doc), { header: { text: '', paras } }),
      'word/header1.xml',
    )
    expect(xml).not.toContain('<w:sdt>')
    expect(xml).toContain('Annual report')
    expect(undeclaredPrefixes(xml)).toEqual([])
  })

  it('a control that uses the w prefix only is kept', async () => {
    const xml = await rewritten(
      `<w:p>${T('Doc ')}<w:sdt>${PLAIN_PR}<w:sdtContent>${T('Annual report')}</w:sdtContent></w:sdt>${T(' end')}</w:p>`,
      true,
    )
    expect(skeleton(xml)).toContain(
      `[Doc ]<w:sdt>${PLAIN_PR}<w:sdtContent>[Annual report]</w:sdtContent></w:sdt>[ enD]`,
    )
    expect(undeclaredPrefixes(xml)).toEqual([])
  })

  it.each([
    ['urn:schemas-microsoft-com:office:word', true],
    ['urn:another', false],
  ])(
    'a control using a prefix the new root declares is kept only while the prefix means the same (%s)',
    async (uri, kept) => {
      const pr = '<w:sdtPr><w:id w:val="5" w10:note="x"/></w:sdtPr>'
      const header = `<w:p>${T('Doc ')}<w:sdt>${pr}<w:sdtContent>${T('Annual report')}</w:sdtContent></w:sdt></w:p>`
      const doc = await parseDocx(await buildWithHeader(header, {}, `xmlns:w10="${uri}"`))
      const xml = await part(
        await saveDocx(doc, originals(doc), { header: { text: '', paras: doc.headerParas! } }),
        'word/header1.xml',
      )
      expect(skeleton(xml)).toContain(
        kept
          ? `[Doc ]<w:sdt>${pr}<w:sdtContent>[Annual report]</w:sdtContent></w:sdt>`
          : '[Doc Annual report]',
      )
      expect(undeclaredPrefixes(xml)).toEqual([])
    },
  )

  it('a header that keeps its own root (it holds a table) keeps the control with its w15 property', async () => {
    const table =
      '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid>' +
      `<w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr><w:p>${T('cell')}</w:p></w:tc></w:tr></w:tbl>`
    const xml = await rewritten(table + CONTROL, true)
    expect(/<w:hdr[^>]*>/.exec(xml)![0]).toContain('mc:Ignorable="w14 w15"')
    expect(skeleton(xml)).toContain(
      `[Doc ]<w:sdt>${APPEARANCE_PR}<w:sdtContent>[Annual report]</w:sdtContent></w:sdt>[ enD]`,
    )
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
  const carried = (runs: Run[]) => runs.filter((r) => r.wrap)

  it('declared on the paragraph only: the control reads and rebuilds as plain runs', async () => {
    const pr = '<w:sdtPr><w:id w:val="5"/><x1:meta x1:k="v"/></w:sdtPr>'
    const runs = await reads(
      `<w:p xmlns:x1="urn:x1">${T('a ')}<w:sdt>${pr}<w:sdtContent>${T('in')}</w:sdtContent></w:sdt>${T(' z')}</w:p>`,
    )
    expect(carried(runs)).toEqual([])
    expect(rebuilt(runs)).toBe(rebuilt(await reads(`<w:p>${T('a ')}${T('in')}${T(' z')}</w:p>`)))
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

  it('nesting inside the control properties past any real document: the text is written without it', async () => {
    const open = `<w:sdt><w:sdtPr>${'<w:rPr>'.repeat(40)}${'</w:rPr>'.repeat(40)}</w:sdtPr><w:sdtContent>`
    const { body } = await saved(withWrap(control(open)))
    expect(body).toBe(PLAIN)
  })
})

describe('a wrapper larger than 64 KiB is not carried', () => {
  const CLOSE = '</w:sdtContent></w:sdt>'
  /** a control whose opening bytes are exactly `size` characters: a long drop-down list */
  const openOf = (size: number): string => {
    const head = '<w:sdt><w:sdtPr><w:alias w:val="'
    const mid = '"/><w:id w:val="5"/><w:dropDownList>'
    const tail = '</w:dropDownList></w:sdtPr><w:sdtContent>'
    const fixed = head.length + mid.length + tail.length
    let items = ''
    for (let i = 0; ; i++) {
      const item = `<w:listItem w:displayText="Option ${i}" w:value="${i}"/>`
      if (fixed + items.length + item.length > size) break
      items += item
    }
    // the title takes what is left over
    return head + 'x'.repeat(size - fixed - items.length) + mid + items + tail
  }
  /** a control whose properties hold one element with `children` children */
  const wide = (children: number): string =>
    `<w:sdt><w:sdtPr><w:rPr>${'<w:b/>'.repeat(children)}</w:rPr></w:sdtPr><w:sdtContent>`
  const reads = async (open: string): Promise<Run[]> =>
    (
      await parseDocx(
        await buildDocx({ bodyXml: `<w:p>${T('a ')}${open}${T('in')}${CLOSE}${T(' z')}</w:p>` }),
      )
    ).blocks[0].runs!
  const plain = async (): Promise<string> =>
    rebuilt(
      (await parseDocx(await buildDocx({ bodyXml: `<w:p>${T('a ')}${T('in')}${T(' z')}</w:p>` })))
        .blocks[0].runs!,
    )

  it('a control with 60 KiB of real properties is carried byte for byte', async () => {
    const open = openOf(60 * 1024)
    expect(open).toHaveLength(60 * 1024)
    expect(rebuilt(await reads(open))).toBe(
      `<w:p>${T('a ')}${open}${T('in')}${CLOSE}${T(' z')}</w:p>`,
    )
  })

  it('the bound is on the opening and closing bytes together', async () => {
    const atBound = openOf(65536 - CLOSE.length)
    expect(rebuilt(await reads(atBound))).toContain(atBound)
    const runs = await reads(openOf(65536 - CLOSE.length + 1))
    expect(runs.filter((r) => r.wrap)).toEqual([])
    expect(rebuilt(runs)).toBe(await plain())
  })

  it('a file whose control properties hold 200,000 children opens, and reads as plain runs', async () => {
    const runs = await reads(wide(200_000))
    expect(runs.map(({ effective: _effective, ...run }) => run)).toEqual([{ text: 'a in z' }])
    expect(rebuilt(runs)).toBe(await plain())
  })

  it('the same wrapper put on a run: the paragraph is saved without it, text kept', async () => {
    const doc = await parseDocx(
      await buildDocx({
        bodyXml: `<w:p>${T('a ')}${T('in', '<w:rPr><w:b/></w:rPr>')}${T(' z')}</w:p>`,
      }),
    )
    const [first] = doc.blocks
    const runs = first.runs!.map((r) =>
      r.text === 'in' ? { ...r, wrap: [{ seq: 0, open: wide(200_000), close: CLOSE }] } : r,
    )
    const bytes = await saveDocx(doc, [
      { kind: 'generated', block: { type: 'paragraph', runs }, docxIndex: first.docxIndex! },
    ])
    const again = await parseDocx(bytes)
    expect(again.blocks[0].runs!.map((r) => r.text).join('')).toBe('a in z')
    expect(bodyOf(again.internal.documentXml)).toBe(
      `<w:p>${T('a ')}${T('in', '<w:rPr><w:b/></w:rPr>')}${T(' z')}</w:p>`,
    )
  })
})
