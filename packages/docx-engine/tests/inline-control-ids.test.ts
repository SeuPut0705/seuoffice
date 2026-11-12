import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import {
  generateTableModelXml,
  parseDocx,
  saveDocx,
  patchTableCellTexts,
  patchTextboxParas,
  type Run,
  type SaveBlock,
} from '../src/index'
import { buildDocx } from './helpers/build-docx'
import { buildWithHeader, count, T } from './helpers/inline-wrap'

const C = (text: string, id = '7') =>
  `<w:sdt><w:sdtPr><w:id w:val="${id}"/></w:sdtPr><w:sdtContent>${T(text)}</w:sdtContent></w:sdt>`
const P = (text: string) => `<w:p>${C(text)}</w:p>`
const table = (a: string, b: string) =>
  `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:tcPr/>${a}</w:tc><w:tc><w:tcPr/>${b}</w:tc></w:tr></w:tbl>`
const originals = (doc: Awaited<ReturnType<typeof parseDocx>>): SaveBlock[] =>
  doc.blocks.filter((b) => !b.hidden).map((b) => ({ kind: 'original', docxIndex: b.docxIndex! }))
const generated = (runs: Run[]): SaveBlock => ({
  kind: 'generated',
  block: { type: 'paragraph', runs },
})
async function part(bytes: Uint8Array, path = 'word/document.xml'): Promise<string> {
  return (await JSZip.loadAsync(bytes)).file(path)!.async('string')
}

describe('only engine-generated controls yield a duplicate id in their own part', () => {
  it('an unedited source with duplicate ids stays byte-identical', async () => {
    const source = await buildDocx({ bodyXml: P('first') + P('second') })
    const doc = await parseDocx(source)
    expect(await saveDocx(doc, originals(doc))).toEqual(source)
  })

  it.each([true, false])(
    'copied original wins regardless of generated position (generated first=%s)',
    async (first) => {
      const doc = await parseDocx(await buildDocx({ bodyXml: P('original') }))
      const g = generated(doc.blocks[0].runs!.map((r) => ({ ...r, text: 'generated' })))
      const o = originals(doc)[0]
      const xml = await part(await saveDocx(doc, first ? [g, o] : [o, g]))
      expect(count(xml, '<w:sdt>')).toBe(1)
      expect(xml).toContain(P('original'))
      expect(xml).toContain(`<w:p>${T('generated')}</w:p>`)
    },
  )

  it('the first of two generated paragraphs keeps the id', async () => {
    const doc = await parseDocx(await buildDocx({ bodyXml: P('first') }))
    const runs = doc.blocks[0].runs!
    const xml = await part(
      await saveDocx(doc, [
        generated(runs),
        generated(runs.map((r) => ({ ...r, text: 'second' }))),
      ]),
    )
    expect(xml).toContain(P('first'))
    expect(xml).toContain(`<w:p>${T('second')}</w:p>`)
    expect(count(xml, '<w:sdt>')).toBe(1)
  })

  it('verbatim xml reserves its ids and bytes even after a generated paragraph', async () => {
    const doc = await parseDocx(await buildDocx({ bodyXml: P('first') }))
    // the comment the engine itself puts before a control that may give way
    const raw = `<w:p><!--seuoffice-inline-yields-->${C('verbatim').replace('w:val="7"', "w:val='7'")}</w:p>`
    const xml = await part(
      await saveDocx(doc, [generated(doc.blocks[0].runs!), { kind: 'xml', xml: raw }]),
    )
    expect(xml).toContain(raw)
    expect(xml).toContain(`<w:p>${T('first')}</w:p>`)
    expect(count(xml, '<w:sdt>')).toBe(1)
  })

  it('header and body are separate id scopes; two generated header paragraphs are not', async () => {
    const doc = await parseDocx(await buildWithHeader(P('header'), { bodyXml: P('body') }))
    const p = doc.headerParas![0]
    const bytes = await saveDocx(doc, originals(doc), {
      header: {
        text: '',
        paras: [p, { ...p, runs: p.runs.map((r) => ({ ...r, text: 'second' })) }],
      },
    })
    expect(await part(bytes)).toContain(P('body'))
    const hdr = await part(bytes, 'word/header1.xml')
    expect(count(hdr, '<w:sdt>')).toBe(1)
    expect(hdr).toContain(C('header'))
    expect(hdr).toContain(T('second'))
  })

  it('an untouched header table reserves its id before generated header text', async () => {
    const doc = await parseDocx(
      await buildWithHeader(P('header') + table(P('original cell'), '<w:p/>')),
    )
    const bytes = await saveDocx(doc, originals(doc), {
      header: { text: '', paras: doc.headerParas! },
    })
    const hdr = await part(bytes, 'word/header1.xml')
    expect(hdr).toContain(P('original cell'))
    expect(count(hdr, '<w:sdt>')).toBe(1)
    expect(hdr).toContain(T('header'))
  })

  it('an untouched table cell reserves its id before a generated cell', async () => {
    const doc = await parseDocx(await buildDocx({ bodyXml: table(P('edited'), P('original')) }))
    const b = doc.blocks.find((b) => b.table)!
    const runs = b.table!.rows[0][0].richParas![0].runs
    const xml = patchTableCellTexts(b.originalXml!, [[[{ runs }], null]])
    expect(xml).toContain(P('original'))
    expect(xml).toContain(`<w:p>${T('edited')}</w:p>`)
    expect(count(xml, '<w:sdt>')).toBe(1)
  })

  it.each([false, true])(
    'a fully regenerated table shares one id scope across cells (original properties=%s)',
    async (keepProperties) => {
      const doc = await parseDocx(await buildDocx({ bodyXml: table(P('first'), P('second')) }))
      const b = doc.blocks.find((b) => b.table)!
      const xml = generateTableModelXml(b.table!, keepProperties ? b.originalXml! : undefined)
      expect(count(xml, '<w:sdt>')).toBe(1)
      expect(xml).toContain(C('first'))
      expect(xml).toContain(T('second'))
      expect(xml).not.toContain(C('second'))
    },
  )

  it('text boxes share their enclosing part id scope', async () => {
    const box = `<w:p><w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml" style="width:200pt;height:50pt"><v:textbox><w:txbxContent>${P('edited')}${P('original')}</w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>`
    const doc = await parseDocx(await buildDocx({ bodyXml: box }))
    const b = doc.blocks.find((b) => b.textboxes?.length)!
    const xml = patchTextboxParas(b.originalXml!, {
      byIndex: [[{ runs: b.textboxes![0].paras[0].runs }, null]],
    })
    expect(xml).toContain(P('original'))
    expect(xml).toContain(`<w:p>${T('edited')}</w:p>`)
    expect(count(xml, '<w:sdt>')).toBe(1)
  })
})

/**
 * Controls the engine wrote before runs carried wrappers (a checkbox control,
 * the block control a paragraph sits in) repeat their id wherever the source
 * or a copy repeats it: a rebuilt paragraph writes them as it always did.
 */
describe('a checkbox control and a block control never give up their id', () => {
  const CB = (id: string) =>
    `<w:sdt><w:sdtPr><w:id w:val="${id}"/><w14:checkbox xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">` +
    '<w14:checked w14:val="0"/><w14:checkedState w14:val="2612" w14:font="MS Gothic"/>' +
    '<w14:uncheckedState w14:val="2610" w14:font="MS Gothic"/></w14:checkbox></w:sdtPr>' +
    '<w:sdtContent><w:r><w:t>\u2610</w:t></w:r></w:sdtContent></w:sdt>'
  const BLK = (id: string, inner: string) =>
    `<w:sdt><w:sdtPr><w:alias w:val="Blk"/><w:tag w:val="t${id}"/><w:id w:val="${id}"/></w:sdtPr><w:sdtContent>${inner}</w:sdtContent></w:sdt>`
  const TAIL = `<w:p>${T('tail')}</w:p>`
  type Doc = Awaited<ReturnType<typeof parseDocx>>
  type Blk = Doc['blocks'][number]
  const original = (b: Blk): SaveBlock => ({ kind: 'original', docxIndex: b.docxIndex! })
  /** the block rebuilt from its runs: `edit` retypes its first plain text, `anchored` false = a pasted copy */
  const rebuilt = (b: Blk, edit = false, anchored = true): SaveBlock => ({
    kind: 'generated',
    block: {
      type: 'paragraph',
      runs: b.runs!.map((r, i) => (edit && i === 0 ? { ...r, text: r.text.toUpperCase() } : r)),
      ...(b.sdtShell ? { sdtShell: b.sdtShell } : {}),
    },
    ...(anchored ? { docxIndex: b.docxIndex! } : {}),
  })
  const saved = async (bodyXml: string, plan: (blocks: Blk[]) => SaveBlock[]): Promise<string> => {
    const doc = await parseDocx(await buildDocx({ bodyXml }))
    const xml = await part(await saveDocx(doc, plan(doc.blocks.filter((b) => !b.hidden))))
    return xml.slice(xml.indexOf('<w:body>') + 8, xml.lastIndexOf('<w:sectPr'))
  }

  const TWO_BOXES = `<w:p>${T('agree ')}${CB('42')}</w:p><w:p>${T('also ')}${CB('42')}</w:p>${TAIL}`
  it.each([0, 1])(
    'two checkboxes with one id in the source: text edited in paragraph %s, both boxes stay',
    async (edited) => {
      const body = await saved(TWO_BOXES, (v) =>
        v.map((b, i) => (i === edited ? rebuilt(b, true) : original(b))),
      )
      expect(count(body, '<w14:checkbox')).toBe(2)
      expect(count(body, '<w:id w:val="42"/>')).toBe(2)
    },
  )

  const ONE_BOX = `<w:p>${T('agree ')}${CB('42')}</w:p>${TAIL}`
  it.each([true, false])(
    'a pasted copy of a checkbox paragraph keeps its checkbox (source paragraph edited=%s)',
    async (edited) => {
      const body = await saved(ONE_BOX, (v) => [
        edited ? rebuilt(v[0], true) : original(v[0]),
        rebuilt(v[0], false, false),
        original(v[1]),
      ])
      expect(count(body, '<w14:checkbox')).toBe(2)
    },
  )

  it('one run holding two box glyphs is written as two checkboxes', async () => {
    const doc = await parseDocx(await buildDocx({ bodyXml: ONE_BOX }))
    const [first, tail] = doc.blocks.filter((b) => !b.hidden)
    const runs = first.runs!.map((r) => (r.sdtCheckboxXml ? { ...r, text: r.text + r.text } : r))
    const xml = await part(
      await saveDocx(doc, [
        { kind: 'generated', block: { type: 'paragraph', runs }, docxIndex: first.docxIndex! },
        original(tail),
      ]),
    )
    expect(count(xml, '<w14:checkbox')).toBe(2)
  })

  const TWO_BLOCKS = `${BLK('5', `<w:p>${T('one')}</w:p>`)}${BLK('5', `<w:p>${T('two')}</w:p>`)}${TAIL}`
  it.each([0, 1])(
    'two block controls with one id in the source: paragraph %s edited, both controls stay',
    async (edited) => {
      const body = await saved(TWO_BLOCKS, (v) =>
        v.map((b, i) => (i === edited ? rebuilt(b, true) : original(b))),
      )
      expect(count(body, '<w:alias w:val="Blk"/>')).toBe(2)
      expect(count(body, '<w:sdtContent>')).toBe(2)
    },
  )

  it('a copied paragraph of a block control keeps the control around it', async () => {
    const body = await saved(`${BLK('5', `<w:p>${T('one')}</w:p>`)}${TAIL}`, (v) => [
      rebuilt(v[0], true),
      rebuilt(v[0], false, false),
      original(v[1]),
    ])
    expect(count(body, '<w:alias w:val="Blk"/>')).toBe(2)
  })

  it('a checkbox with the id of the block control it sits in stays', async () => {
    const body = await saved(`${BLK('5', `<w:p>${T('agree ')}${CB('5')}</w:p>`)}${TAIL}`, (v) =>
      v.map((b, i) => (i === 0 ? rebuilt(b, true) : original(b))),
    )
    expect(count(body, '<w:alias w:val="Blk"/>')).toBe(1)
    expect(count(body, '<w14:checkbox')).toBe(1)
  })

  it('a text box written twice by Word (mc:Choice and mc:Fallback): both copies keep the checkbox', async () => {
    const inner = `<w:txbxContent><w:p>${T('agree ')}${CB('42')}</w:p></w:txbxContent>`
    const box =
      `<w:p>${T('anchor ')}<w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">` +
      '<mc:Choice Requires="wps"><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">' +
      '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH>' +
      '<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="1000000" cy="500000"/>' +
      '<wp:wrapNone/><wp:docPr id="1" name="Text Box 1"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
      '<wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:cNvSpPr txBox="1"/>' +
      '<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="500000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr>' +
      `<wps:txbx>${inner}</wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice>` +
      '<mc:Fallback><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml" type="#_x0000_t202" style="width:80pt;height:40pt">' +
      `<v:textbox>${inner}</v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`
    const doc = await parseDocx(await buildDocx({ bodyXml: box + TAIL }))
    const block = doc.blocks[0]
    const runs = block.textboxes![0].paras[0].runs.map((r, i) =>
      i === 0 ? { ...r, text: r.text.toUpperCase() } : r,
    )
    const xml = patchTextboxParas(block.originalXml!, { byIndex: [[{ runs }]] })
    expect(count(xml, 'AGREE ')).toBe(2)
    expect(count(xml, '<w14:checkbox')).toBe(2)
  })

  it.each([true, false])(
    'a checkbox still takes its id: a run-carried control with that id yields (control first=%s)',
    async (controlFirst) => {
      const control = `<w:p>${T('plain ')}${C('ctl', '42')}</w:p>`
      const boxed = `<w:p>${T('agree ')}${CB('42')}</w:p>`
      const body = await saved(controlFirst ? control + boxed : boxed + control, (v) =>
        v.map((b) => rebuilt(b, true)),
      )
      expect(count(body, '<w14:checkbox')).toBe(1)
      expect(count(body, '<w:sdt>')).toBe(1)
      expect(body).toContain(`<w:p>${T('PLAIN ')}${T('ctl')}</w:p>`)
    },
  )
})
