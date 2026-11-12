import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import {
  compareDocuments,
  generateParagraphXml,
  mergeBlockTree,
  mergeRecords,
  parseDocx,
  patchTableCellTexts,
  patchTextboxParas,
  saveDocx,
  type Block,
  type HeaderFooter,
  type Run,
  type SaveBlock,
} from '../src/index'
import { buildDocx } from './helpers/build-docx'
import { HYPERLINK_REL, T, buildWithHeader, count, genCtx, skeleton } from './helpers/inline-wrap'

/**
 * Run-level structure the run model has no field for stays in a paragraph
 * that is rebuilt from the model: wrapper elements around runs (w:sdt,
 * w:smartTag, w:customXml, w:dir, w:bdo) and elements without text
 * (w:permStart / w:permEnd, customXml range markers).
 */

// written the way a file may write it, not the way a serializer would: single
// quotes, an empty element with a closing tag, an entity in an attribute
const SDT_PR =
  '<w:sdtPr><w:alias w:val=\'Due &amp; date\'></w:alias><w:tag w:val="due"/><w:id w:val="1234567"/>' +
  '<w:lock w:val="contentLocked"/>' +
  '<w:dataBinding w:prefixMappings="" w:xpath="/root[1]/due[1]" w:storeItemID="{11111111-2222-3333-4444-555555555555}"/>' +
  '<w:date w:fullDate="2024-05-06T00:00:00Z"><w:dateFormat w:val="M/d/yyyy"/><w:lid w:val="en-US"/>' +
  '<w:storeMappedDataAs w:val="dateTime"/><w:calendar w:val="gregorian"/></w:date></w:sdtPr>'

interface Kind {
  open: string
  close: string
}
const KINDS: Record<string, Kind> = {
  'w:sdt': { open: `<w:sdt>${SDT_PR}<w:sdtContent>`, close: '</w:sdtContent></w:sdt>' },
  'w:smartTag': {
    open:
      '<w:smartTag w:uri="urn:schemas-microsoft-com:office:smarttags" w:element="place">' +
      '<w:smartTagPr><w:attr w:name=\'k\' w:val="v"></w:attr></w:smartTagPr>',
    close: '</w:smartTag>',
  },
  'w:customXml': {
    open:
      '<w:customXml w:uri="urn:x" w:element="city">' +
      '<w:customXmlPr><w:attr w:name="k" w:val="v"/></w:customXmlPr>',
    close: '</w:customXml>',
  },
  'w:bdo': { open: "<w:bdo w:val='rtl'>", close: '</w:bdo>' },
  'w:dir': { open: '<w:dir w:val="rtl">', close: '</w:dir>' },
  'w:permStart / w:permEnd': {
    open: '<w:permStart w:id=\'77\' w:edGrp="everyone"/>',
    close: '<w:permEnd w:id="77"/>',
  },
  'customXml range markers': {
    open: '<w:customXmlInsRangeStart w:id="3" w:author="A" w:date="2024-01-01T00:00:00Z"/>',
    close: '<w:customXmlInsRangeEnd w:id="3"/>',
  },
  'w:subDoc': { open: '<w:subDoc r:id="rId20"/>', close: '' },
}

const BOLD = '<w:rPr><w:b/></w:rPr>'
const around = (kind: Kind) =>
  `<w:p>${T('Meet ')}${kind.open}${T('Seoul', BOLD)}${kind.close}${T(' soon')}</w:p>`

const OTHER = '<w:p><w:r><w:t>Untouched paragraph</w:t></w:r></w:p>'

// a plain control, a smart tag and markers in the generator's own spelling
const SDT: Kind = {
  open: '<w:sdt><w:sdtPr><w:tag w:val="t"/><w:id w:val="9"/></w:sdtPr><w:sdtContent>',
  close: '</w:sdtContent></w:sdt>',
}
const SMART: Kind = { open: '<w:smartTag w:uri="urn:x" w:element="place">', close: '</w:smartTag>' }
const PERM: Kind = {
  open: '<w:permStart w:id="7" w:edGrp="everyone"/>',
  close: '<w:permEnd w:id="7"/>',
}
const REV = 'w:author="Ada" w:date="2024-01-01T00:00:00Z"'
const LINK = '<w:hyperlink r:id="rId20">'
const LINK_STYLE = '<w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr>'
const F = (type: string) => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`
const I = (instr: string) => `<w:r><w:instrText xml:space="preserve">${instr}</w:instrText></w:r>`

async function entries(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const zip = await JSZip.loadAsync(bytes)
  const out = new Map<string, Uint8Array>()
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) out.set(name, await entry.async('uint8array'))
  }
  return out
}

const allOriginal = (blocks: Block[]): SaveBlock[] =>
  blocks
    .filter((b) => !b.hidden)
    .map((b) => ({ kind: 'original' as const, docxIndex: b.docxIndex! }))

/** every block original except `edited`, which is rebuilt from the model with `runs` */
function withRebuilt(blocks: Block[], edited: Block, runs: Run[]): SaveBlock[] {
  return blocks
    .filter((b) => !b.hidden)
    .map((b) =>
      b === edited
        ? { kind: 'generated', block: { type: 'paragraph', runs }, docxIndex: b.docxIndex! }
        : { kind: 'original', docxIndex: b.docxIndex! },
    )
}

const retyped = (runs: Run[]): Run[] =>
  runs.map((r, i) => (i === 0 ? { ...r, text: `X${r.text}` } : r))

/** the runs one paragraph (given by its content) reads as */
async function runsOf(content: string): Promise<Run[]> {
  const doc = await parseDocx(
    await buildDocx({ bodyXml: `<w:p>${content}</w:p>`, extraRels: HYPERLINK_REL }),
  )
  return doc.blocks[0].runs!
}

const rebuilt = (runs: Run[]): string => generateParagraphXml({ type: 'paragraph', runs }, genCtx())

/** `runs` with the run whose text is `text` changed */
const withRun = (runs: Run[], text: string, change: (run: Run) => Run | Run[]): Run[] =>
  runs.flatMap((r) => (r.text === text ? change(r) : [r]))

describe('a paragraph rebuilt from the model keeps what the model does not represent', () => {
  for (const [name, kind] of Object.entries(KINDS)) {
    it(`${name}: bytes stay where they were, the runs between them too`, async () => {
      const source = await buildDocx({ bodyXml: around(kind) + OTHER, extraRels: HYPERLINK_REL })
      const doc = await parseDocx(source)
      const para = doc.blocks[0]
      expect(para.type).toBe('paragraph')
      expect(para.runs!.map((r) => r.text).join('')).toBe('Meet Seoul soon')

      const saved = await saveDocx(doc, withRebuilt(doc.blocks, para, retyped(para.runs!)))
      const xml = (await parseDocx(saved)).internal.documentXml
      const edited = xml.slice(xml.indexOf('<w:p>'), xml.indexOf(OTHER))
      expect(skeleton(edited)).toBe(`<w:p>[XMeet ]${kind.open}[Seoul]${kind.close}[ soon]</w:p>`)
      // the run inside keeps its own formatting
      expect(edited).toContain(`${kind.open}${T('Seoul', BOLD)}`)
    })

    it(`${name}: no edit gives the file back, and its runs rebuild to the paragraph's own bytes`, async () => {
      const source = await buildDocx({ bodyXml: around(kind) + OTHER, extraRels: HYPERLINK_REL })
      const doc = await parseDocx(source)
      expect(await saveDocx(doc, allOriginal(doc.blocks))).toBe(source)
      // rebuilt from the model without any change: byte for byte the source paragraph
      expect(rebuilt(doc.blocks[0].runs!)).toBe(around(kind))
    })
  }

  it('one block edited: every other w:p and every other zip entry is byte-identical', async () => {
    const source = await buildDocx({ bodyXml: OTHER + around(KINDS['w:sdt']) + OTHER })
    const doc = await parseDocx(source)
    const para = doc.blocks[1]
    const saved = await saveDocx(doc, withRebuilt(doc.blocks, para, retyped(para.runs!)))
    const before = await entries(source)
    const after = await entries(saved)
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    for (const [path, content] of before) {
      if (path !== 'word/document.xml') expect(after.get(path), path).toEqual(content)
    }
    const xml = new TextDecoder().decode(after.get('word/document.xml')!)
    expect(xml.split(OTHER)).toHaveLength(3)
    expect(xml).toContain(`<w:sdt>${SDT_PR}<w:sdtContent>`)
  })

  it('reading reports the same inline controls as before, and again after the rebuild', async () => {
    const source = await buildDocx({ bodyXml: around(KINDS['w:sdt']) })
    const doc = await parseDocx(source)
    const before = doc.blocks[0].inlineContentControls
    expect(before).toMatchObject([
      { tag: 'due', lock: 'contentLocked', id: '1234567', text: 'Seoul' },
    ])
    const saved = await saveDocx(
      doc,
      withRebuilt(doc.blocks, doc.blocks[0], retyped(doc.blocks[0].runs!)),
    )
    expect((await parseDocx(saved)).blocks[0].inlineContentControls).toEqual(before)
  })

  it('runs formatted apart inside one control go back into that one control', async () => {
    const runs = withRun(
      await runsOf(`${T('Meet ')}${SDT.open}${T('Seoul')}${SDT.close}`),
      'Seoul',
      (r) => [
        { ...r, text: 'Se' },
        { ...r, text: 'oul', italic: true },
      ],
    )
    expect(skeleton(rebuilt(runs))).toBe(`<w:p>[Meet ]${SDT.open}[Se][oul]${SDT.close}</w:p>`)
  })

  it('nested wrappers keep their nesting, each around its own runs', async () => {
    const content = `${T('In ')}${SMART.open}${SDT.open}${T('Seoul')}${SDT.close}${T(', Korea')}${SMART.close}`
    expect(rebuilt(await runsOf(content))).toBe(`<w:p>${content}</w:p>`)
  })

  it('a control holding no run at all is kept whole, where it was', async () => {
    const empty =
      '<w:sdt><w:sdtPr><w:tag w:val="empty"/><w:id w:val="9"/></w:sdtPr><w:sdtContent/></w:sdt>'
    const noContent = '<w:sdt><w:sdtPr><w:tag w:val="bare"/></w:sdtPr></w:sdt>'
    const content = `${T('before')}${empty}${T('middle')}${noContent}${T('after')}`
    expect(rebuilt(await runsOf(content))).toBe(`<w:p>${content}</w:p>`)
  })

  it('a paragraph whose source cannot be sliced still keeps the wrapper (serialized)', async () => {
    // a comment makes tag offsets unreliable: the parse tree stands in
    const body = `<w:p><!-- note -->${T('Meet ')}${SMART.open}${T('Seoul')}${SMART.close}</w:p>`
    const doc = await parseDocx(await buildDocx({ bodyXml: body }))
    const para = doc.blocks.find((b) => b.type === 'paragraph')!
    expect(skeleton(rebuilt(para.runs!))).toBe(
      `<w:p>[Meet ]${SMART.open}[Seoul]${SMART.close}</w:p>`,
    )
  })

  it('proofing marks are dropped (Word recomputes them); the marker between them is not', async () => {
    const content =
      `<w:proofErr w:type="spellStart"/>${PERM.open}${T('Seoul')}${PERM.close}` +
      '<w:proofErr w:type="spellEnd"/>'
    expect(rebuilt(await runsOf(content))).toBe(`<w:p>${PERM.open}${T('Seoul')}${PERM.close}</w:p>`)
  })
})

describe('a content control is written once (its w:id is never repeated)', () => {
  it('runs of one control that are no longer adjacent: the first group keeps it, the later one is plain', async () => {
    const runs = await runsOf(
      `${T('a ')}${SDT.open}${T('one')}${T('two', BOLD)}${SDT.close}${T(' z')}`,
    )
    const [a, one, two, z] = runs
    expect(skeleton(rebuilt([a, one, z, two]))).toBe(
      `<w:p>[a ]${SDT.open}[one]${SDT.close}[ z][two]</w:p>`,
    )
    // a run the user typed between the two without the control does the same
    expect(skeleton(rebuilt([a, one, { text: 'mid' }, two, z]))).toBe(
      `<w:p>[a ]${SDT.open}[one]${SDT.close}[mid][two][ z]</w:p>`,
    )
  })

  it('a wrapper without identity keeps its own element on each group (text direction must not flip)', async () => {
    const bdo: Kind = { open: '<w:bdo w:val="rtl">', close: '</w:bdo>' }
    const [one, two] = await runsOf(`${bdo.open}${T('one')}${T('two', BOLD)}${bdo.close}`)
    expect(skeleton(rebuilt([one, { text: 'mid' }, two]))).toBe(
      `<w:p>${bdo.open}[one]${bdo.close}[mid]${bdo.open}[two]${bdo.close}</w:p>`,
    )
  })

  it('header: the runs of one control go back into one control', async () => {
    const header =
      `<w:p>${T('Title ')}<w:sdt><w:sdtPr><w:id w:val="5"/><w:dataBinding w:xpath="/a" w:storeItemID="{X}"/></w:sdtPr>` +
      `<w:sdtContent>${T('bold', BOLD)}${T(' plain')}</w:sdtContent></w:sdt></w:p>`
    const doc = await parseDocx(await buildWithHeader(header))
    const edited: HeaderFooter = {
      text: doc.headerText ?? '',
      paras: doc.headerParas!.map((p) => ({ ...p, runs: retyped(p.runs) })),
    }
    const saved = await saveDocx(doc, allOriginal(doc.blocks), { header: edited })
    const hdr = await (await JSZip.loadAsync(saved)).file('word/header1.xml')!.async('string')
    expect(count(hdr, '<w:sdt>')).toBe(1)
    expect(count(hdr, 'w:id w:val="5"')).toBe(1)
    expect(skeleton(hdr)).toContain('[XTitle ]<w:sdt>')
    expect(skeleton(hdr)).toContain('<w:sdtContent>[bold][ plain]</w:sdtContent></w:sdt>')
  })

  it('header: a control holding only the watermark picture is not written a second time', async () => {
    const watermark =
      '<w:r><w:pict><v:shape id="PowerPlusWaterMarkObject1" type="#_x0000_t136" ' +
      'style="position:absolute;width:412pt;height:247pt;rotation:315;z-index:-251658752" ' +
      'fillcolor="silver" stroked="f"><v:textpath style="font-size:1pt" string="DRAFT"/></v:shape></w:pict></w:r>'
    const header =
      '<w:p><w:sdt><w:sdtPr><w:id w:val="-19"/><w:docPartObj><w:docPartGallery w:val="Watermarks"/>' +
      `</w:docPartObj></w:sdtPr><w:sdtContent>${watermark}</w:sdtContent></w:sdt>${T('Company')}</w:p>`
    const doc = await parseDocx(await buildWithHeader(header))
    const edited: HeaderFooter = {
      text: doc.headerText ?? '',
      paras: doc.headerParas!.map((p) => ({ ...p, runs: retyped(p.runs) })),
    }
    const saved = await saveDocx(doc, allOriginal(doc.blocks), { header: edited })
    const hdr = await (await JSZip.loadAsync(saved)).file('word/header1.xml')!.async('string')
    expect(count(hdr, 'PowerPlusWaterMarkObject1')).toBe(1)
    expect(count(hdr, 'w:id w:val="-19"')).toBeLessThanOrEqual(1)
    expect(hdr).toContain('XCompany')
  })
})

describe('a wrapper goes back at the depth it was read at', () => {
  /** [what it shows, the paragraph content: rebuilt unchanged it must come back as written] */
  const SHAPES: Array<[string, string]> = [
    [
      'hyperlink > smart tag > control, with more runs of the same hyperlink around it',
      `${LINK}${T('See ', LINK_STYLE)}${SMART.open}${T('Kim ', LINK_STYLE)}${SDT.open}${T('Seoul', LINK_STYLE)}${SDT.close}${SMART.close}${T(' now', LINK_STYLE)}</w:hyperlink>`,
    ],
    [
      'control > hyperlink',
      `${T('a ')}${SDT.open}${LINK}${T('site', LINK_STYLE)}</w:hyperlink>${SDT.close}`,
    ],
    [
      'an edit-permission range inside a hyperlink',
      `${LINK}${T('a', LINK_STYLE)}${PERM.open}${T('b', LINK_STYLE)}${PERM.close}${T('c', LINK_STYLE)}</w:hyperlink>`,
    ],
    [
      'w:ins > control (the control itself was inserted)',
      `${T('a ')}<w:ins w:id="5" ${REV}>${SDT.open}${T('new')}${SDT.close}</w:ins>${T(' z')}`,
    ],
    [
      'control > w:ins (text was inserted into the control)',
      `${T('a ')}${SDT.open}${T('old ')}<w:ins w:id="5" ${REV}>${T('new')}</w:ins>${SDT.close}${T(' z')}`,
    ],
    [
      'w:ins > smart tag > hyperlink > control',
      `<w:ins w:id="5" ${REV}>${SMART.open}${LINK}${SDT.open}${T('new', LINK_STYLE)}${SDT.close}</w:hyperlink>${SMART.close}</w:ins>`,
    ],
    [
      'a whole field inside a control',
      `${SDT.open}${F('begin')}${I(' DATE ')}${F('separate')}${T('1 May')}${F('end')}${SDT.close}`,
    ],
  ]
  for (const [name, content] of SHAPES) {
    it(`${name}: rebuilt unchanged, it is the same xml`, async () => {
      expect(rebuilt(await runsOf(content))).toBe(`<w:p>${content}</w:p>`)
    })
  }

  it('runs of an inserted control that are no longer all inserted: one control around all of them', async () => {
    const runs = await runsOf(
      `<w:ins w:id="5" ${REV}>${SDT.open}${T('one')}${T('two', BOLD)}${SDT.close}</w:ins>`,
    )
    // the user accepted the insertion of the second run only
    const accepted = withRun(runs, 'two', ({ ins: _ins, ...r }) => r)
    expect(skeleton(rebuilt(accepted))).toBe(
      `<w:p>${SDT.open}<w:ins w:id="5" ${REV}>[one]</w:ins>[two]${SDT.close}</w:p>`,
    )
  })

  it('a hyperlink set across a wrapper takes the wrapper inside it instead of being cut in three', async () => {
    const runs = await runsOf(`${T('x ')}${SMART.open}${T('y')}${SMART.close}${T(' z')}`)
    const link = { href: 'https://example.com/', rId: 'rId20' }
    const xml = rebuilt(runs.map((r) => ({ ...r, link })))
    expect(count(xml, '<w:hyperlink')).toBe(1)
    expect(skeleton(xml)).toBe(
      `<w:p>${LINK}[x ]${SMART.open}[y]${SMART.close}[ z]</w:hyperlink></w:p>`,
    )
  })

  it('runs of a wrapper inside a hyperlink that lost the link: the wrapper stays one element', async () => {
    const runs = await runsOf(
      `${LINK}${SMART.open}${T('one', LINK_STYLE)}${T('two', BOLD)}${SMART.close}</w:hyperlink>`,
    )
    const unlinked = withRun(runs, 'two', ({ link: _link, ...r }) => r)
    const xml = rebuilt(unlinked)
    expect(count(xml, '<w:smartTag')).toBe(1)
    expect(skeleton(xml)).toBe(
      `<w:p>${SMART.open}${LINK}[one]</w:hyperlink>[two]${SMART.close}</w:p>`,
    )
  })
})

describe('shapes that are not carried: read and rebuilt as before, their text once', () => {
  /** [what it shows, the content, the same content without the wrapper (what a rebuild gives)] */
  const SHAPES: Array<[string, string, string]> = [
    [
      'a smart tag inside a HYPERLINK field result',
      `${T('See ')}${F('begin')}${I(' HYPERLINK "mailto:kim@example.test" ')}${F('separate')}${SMART.open}${T('kim@example.test')}${SMART.close}${F('end')}`,
      `${T('See ')}${F('begin')}${I(' HYPERLINK "mailto:kim@example.test" ')}${F('separate')}${T('kim@example.test')}${F('end')}`,
    ],
    [
      'a smart tag inside a REF field result',
      `${T('See ')}${F('begin')}${I(' REF bm \\h ')}${F('separate')}${SMART.open}${T('Seoul')}${SMART.close}${F('end')}`,
      `${T('See ')}${F('begin')}${I(' REF bm \\h ')}${F('separate')}${T('Seoul')}${F('end')}`,
    ],
    [
      'a control inside a PAGE field result',
      `${T('Page ')}${F('begin')}${I(' PAGE ')}${F('separate')}${SDT.open}${T('3')}${SDT.close}${F('end')}`,
      `${T('Page ')}${F('begin')}${I(' PAGE ')}${F('separate')}${T('3')}${F('end')}`,
    ],
    [
      'a field that begins inside a control and ends after it',
      `${SDT.open}${F('begin')}${I(' DATE ')}${F('separate')}${T('1 May')}${SDT.close}${F('end')}`,
      `${F('begin')}${I(' DATE ')}${F('separate')}${T('1 May')}${F('end')}`,
    ],
    [
      'hyperlink > smart tag > w:ins',
      `${LINK}${SMART.open}<w:ins w:id="5" ${REV}>${T('Kim')}</w:ins>${SMART.close}</w:hyperlink>`,
      `${LINK}<w:ins w:id="5" ${REV}>${T('Kim')}</w:ins></w:hyperlink>`,
    ],
    [
      'w:ins > control > w:del',
      `<w:ins w:id="5" ${REV}>${SDT.open}<w:del w:id="6" ${REV}><w:r><w:delText>old</w:delText></w:r></w:del>${SDT.close}</w:ins>`,
      `<w:ins w:id="5" ${REV}><w:del w:id="6" ${REV}><w:r><w:delText>old</w:delText></w:r></w:del></w:ins>`,
    ],
  ]
  for (const [name, withIt, withoutIt] of SHAPES) {
    it(name, async () => {
      const runs = await runsOf(withIt)
      expect(runs.filter((r) => r.wrap || r.opaqueXml !== undefined)).toEqual([])
      expect(rebuilt(runs)).toBe(rebuilt(await runsOf(withoutIt)))
    })
  }

  it('table cell: a smart tag inside a field result is not written beside the field', async () => {
    const content = `${T('Go ')}${F('begin')}${I(' HYPERLINK "https://example.com/" ')}${F('separate')}${SMART.open}${T('Seoul')}${SMART.close}${F('end')}`
    const table =
      '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid>' +
      `<w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr><w:p>${content}</w:p></w:tc></w:tr></w:tbl>`
    const doc = await parseDocx(await buildDocx({ bodyXml: table }))
    const block = doc.blocks.find((b) => b.type === 'table')!
    const runs = block.table!.rows[0][0].richParas![0].runs
    const patched = patchTableCellTexts(block.originalXml!, [[[{ runs: retyped(runs) }]]])
    expect(count(patched, 'Seoul')).toBe(1)
  })
})

describe('a control whose properties are tied to its text', () => {
  const pr = (bound: string) =>
    `<w:sdtPr><w:alias w:val="Name"/><w:id w:val="7"/>${bound}<w:text/></w:sdtPr>`
  const BOUND =
    '<w:showingPlcHdr/><w:dataBinding w:prefixMappings="" w:xpath=\'/a[b>1]/c\' w:storeItemID="{11111111-2222-3333-4444-555555555555}"/>'
  const control = (bound: string, inner: string) =>
    `<w:sdt>${pr(bound)}<w:sdtContent>${inner}</w:sdtContent></w:sdt>`
  const read = (bound = BOUND) => runsOf(`${T('Dear ')}${control(bound, T('Click here'))}${T(',')}`)

  it('text typed into it: the placeholder flag and the data binding go, nothing else in w:sdtPr', async () => {
    const typed = withRun(await read(), 'Click here', (r) => ({ ...r, text: 'Kim' }))
    expect(rebuilt(typed)).toBe(`<w:p>${T('Dear ')}${control('', T('Kim'))}${T(',')}</w:p>`)
  })

  it('text changed elsewhere in the paragraph: its w:sdtPr is written back byte for byte', async () => {
    expect(rebuilt(retyped(await read()))).toBe(
      `<w:p>${T('XDear ')}${control(BOUND, T('Click here'))}${T(',')}</w:p>`,
    )
  })

  it('formatting changed inside it, text the same: its w:sdtPr is written back byte for byte', async () => {
    const bolded = withRun(await read(), 'Click here', (r) => ({ ...r, bold: true }))
    expect(rebuilt(bolded)).toContain(`<w:sdt>${pr(BOUND)}<w:sdtContent>`)
  })

  it('a tracked deletion inside it counts as changed text', async () => {
    const del = { author: 'Ada', date: '2024-01-01T00:00:00Z', id: '31' }
    const deleted = withRun(await read(), 'Click here', (r) => ({ ...r, del }))
    const xml = rebuilt(deleted)
    expect(xml).toContain(`<w:sdt>${pr('')}<w:sdtContent>`)
    expect(xml).toContain('<w:delText xml:space="preserve">Click here</w:delText>')
  })

  it('the paired spelling of the two properties goes the same way', async () => {
    const paired =
      '<w:showingPlcHdr></w:showingPlcHdr><w:dataBinding w:xpath="/a" w:storeItemID="{X}"></w:dataBinding>'
    const typed = withRun(await read(paired), 'Click here', (r) => ({ ...r, text: 'Kim' }))
    expect(rebuilt(typed)).toContain(`<w:sdt>${pr('')}<w:sdtContent>`)
  })

  it('saved and read again, the edited control is an ordinary control', async () => {
    const source = await buildDocx({
      bodyXml: `<w:p>${T('Dear ')}${control(BOUND, T('Click here'))}</w:p>`,
    })
    const doc = await parseDocx(source)
    const typed = withRun(doc.blocks[0].runs!, 'Click here', (r) => ({ ...r, text: 'Kim' }))
    const saved = await saveDocx(doc, withRebuilt(doc.blocks, doc.blocks[0], typed))
    const again = await parseDocx(saved)
    expect(again.internal.documentXml).not.toContain('showingPlcHdr')
    expect(again.internal.documentXml).not.toContain('dataBinding')
    expect(again.blocks[0].inlineContentControls).toMatchObject([{ id: '7', text: 'Kim' }])
  })
})

describe('the same paragraph inside a container', () => {
  const sdt = KINDS['w:sdt']
  const cellTable = (inner: string) =>
    '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>' +
    '<w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid>' +
    `<w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>${inner}</w:tc></w:tr></w:tbl>`

  it('table cell: a rebuilt cell paragraph keeps the control with its own bytes', async () => {
    const doc = await parseDocx(await buildDocx({ bodyXml: cellTable(around(sdt)) }))
    const block = doc.blocks.find((b) => b.type === 'table')!
    const runs = block.table!.rows[0][0].richParas![0].runs
    expect(runs.map((r) => r.text).join('')).toBe('Meet Seoul soon')
    const patched = patchTableCellTexts(block.originalXml!, [[[{ runs: retyped(runs) }]]])
    expect(skeleton(patched)).toContain(`[XMeet ]${sdt.open}[Seoul]${sdt.close}[ soon]`)
  })

  it('table cell: a display equation is rebuilt without its properties surfacing beside it', async () => {
    const math =
      '<m:oMathPara><m:oMathParaPr><m:jc m:val="left"/></m:oMathParaPr>' +
      '<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></m:oMathPara>'
    const doc = await parseDocx(
      await buildDocx({ bodyXml: cellTable(`<w:p>${T('a ')}${math}</w:p>`) }),
    )
    const block = doc.blocks.find((b) => b.type === 'table')!
    const runs = block.table!.rows[0][0].richParas![0].runs
    const patched = patchTableCellTexts(block.originalXml!, [[[{ runs: retyped(runs) }]]])
    // m:oMathParaPr is not a child of w:p: nothing may sit between the text run and the equation
    expect(patched).toContain(`${T('Xa ')}<m:oMathPara><m:oMath>`)
    expect(patched).not.toContain('<m:oMathParaPr>')
  })

  it('text box: a rebuilt paragraph keeps the control', async () => {
    // the text box source is read through the parse tree, so the control's
    // properties are written in the form a serializer produces
    const inner = `<w:p>${T('Meet ')}${SDT.open}${T('Seoul')}${SDT.close}</w:p>`
    const box =
      '<w:p><w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml" type="#_x0000_t202" ' +
      'style="width:200pt;height:50pt"><v:textbox>' +
      `<w:txbxContent>${inner}</w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>`
    const doc = await parseDocx(await buildDocx({ bodyXml: box }))
    const block = doc.blocks.find((b) => b.textboxes?.length)!
    const para = block.textboxes![0].paras[0]
    const patched = patchTextboxParas(block.originalXml!, {
      byIndex: [[{ runs: retyped(para.runs), align: null }]],
    })
    expect(skeleton(patched)).toContain(`[XMeet ]${SDT.open}[Seoul]${SDT.close}`)
  })
})

describe('runs that leave their paragraph leave the ids of its structure behind', () => {
  const ctl = (id: string, text: string) =>
    `<w:sdt><w:sdtPr><w:id w:val="${id}"/></w:sdtPr><w:sdtContent>${T(text)}</w:sdtContent></w:sdt>`

  it('compare: a control and a permission range of the original document do not come into the redline', async () => {
    const kept = `<w:p>${T('Kept paragraph')}</w:p>`
    const original = await parseDocx(
      await buildDocx({
        bodyXml: `${kept}<w:p>${PERM.open}${T('Removed ')}${PERM.close}${ctl('41', 'with a control')}</w:p>`,
      }),
    )
    const revised = await parseDocx(await buildDocx({ bodyXml: kept }))
    const { bytes } = await compareDocuments(original, revised, {
      author: 'A',
      date: '2026-01-01T00:00:00Z',
    })
    const xml = await (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string')
    expect(xml).toContain('Removed ')
    expect(xml).toContain('with a control')
    expect(xml).not.toContain('<w:sdt>')
    expect(xml).not.toContain('w:permStart')
  })

  it("compare: the revised document's own control stays in a paragraph whose text changed", async () => {
    const original = await parseDocx(
      await buildDocx({ bodyXml: `<w:p>${T('The quick fox ')}${ctl('41', 'jumps')}</w:p>` }),
    )
    const revised = await parseDocx(
      await buildDocx({ bodyXml: `<w:p>${T('The slow fox ')}${ctl('41', 'jumps')}</w:p>` }),
    )
    const { bytes } = await compareDocuments(original, revised, {
      author: 'A',
      date: '2026-01-01T00:00:00Z',
    })
    const xml = await (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string')
    expect(count(xml, '<w:sdt>')).toBe(1)
    expect(count(xml, 'w:id w:val="41"')).toBe(1)
    expect(skeleton(xml)).toContain('<w:sdtContent>[jumps]</w:sdtContent>')
  })

  // The merge field is given as the neighbouring merge tests give it (a run
  // carrying the instruction): which fields the reader keeps is not under test.
  const mergeName: Run = { text: '«Name»', instrField: 'MERGEFIELD Name' }
  const data = { fields: ['Name'], records: [{ Name: 'Ada' }, { Name: 'Grace' }] }

  it("mail merge: the first record keeps the template's control and markers, later copies go without them", async () => {
    const doc = await parseDocx(
      await buildDocx({
        bodyXml: `<w:p>${T('Dear ')}${ctl('41', 'customer')}${PERM.open}${SMART.open}${T(' of Seoul')}${SMART.close}${PERM.close}</w:p>`,
      }),
    )
    const template: Block = { ...doc.blocks[0], runs: [...doc.blocks[0].runs!, mergeName] }
    const [first, second] = mergeBlockTree([template], data).map((blocks) =>
      skeleton(rebuilt(blocks[0].runs!)),
    )
    const control =
      '<w:sdt><w:sdtPr><w:id w:val="41"/></w:sdtPr><w:sdtContent>[customer]</w:sdtContent></w:sdt>'
    expect(first).toBe(
      `<w:p>[Dear ]${control}${PERM.open}${SMART.open}[ of Seoul]${SMART.close}${PERM.close}[Ada]</w:p>`,
    )
    // the smart tag carries no id: it stays; the control and the range do not
    expect(second).toBe(`<w:p>[Dear ][customer]${SMART.open}[ of Seoul]${SMART.close}[Grace]</w:p>`)
  })

  it('mail merge: a paragraph holding only a control field between kept markers is still consumed', async () => {
    const doc = await parseDocx(
      await buildDocx({ bodyXml: `<w:p>${PERM.open}${PERM.close}</w:p><w:p>${T('x')}</w:p>` }),
    )
    const [markers, line] = doc.blocks
    const [start, end] = markers.runs!
    const template: Block[] = [
      { ...markers, runs: [start, { text: '', instrField: 'NEXT' }, end] },
      { ...line, runs: [mergeName] },
    ]
    // NEXT moves on to the second record and its paragraph leaves no empty line behind
    const { blocks } = mergeRecords(template, data)
    expect(blocks.map((b) => b.runs?.map((r) => r.text).join(''))).toEqual(['Grace'])
  })
})
