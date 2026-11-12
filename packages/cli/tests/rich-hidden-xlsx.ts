import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { expect } from 'vitest'
import { hiddenXlsx, SECRET } from './hidden-text-fixtures'
import { run } from './helpers'

/** what the pictures and the text box over the hidden cell say about it, apart from the cell */
export const DRAWING_GIVEAWAYS = [SECRET, 'ID scan', 'passport', 'ssn-text-box']

/** What the hidden cell gives away: itself, and every figure computed from it. */
export const GIVEAWAYS = [
  SECRET,
  '27600276000',
  '27600276001',
  '13,800,138,000',
  'B2*2',
  'C2+1',
  ...DRAWING_GIVEAWAYS,
]

/** The hidden-phone workbook with a dependent cached value, a note, a list validation and a defined name over the cell. */
export async function richHiddenXlsx(dir: string, name = 'rich.xlsx'): Promise<string> {
  return hiddenXlsx(dir, name, async (path) => {
    const sheetName = /<sheet\b[^>]*\bname="([^"]+)"/.exec(
      await (await JSZip.loadAsync(readFileSync(path))).file('xl/workbook.xml')!.async('string'),
    )![1]!
    const ops = join(dir, `${name}.ops.json`)
    writeFileSync(
      ops,
      JSON.stringify([
        { op: 'set_cell', address: 'D2', value: '=C2+1' },
        { op: 'set_cell', address: 'A3', value: 'Lee' },
        { op: 'set_cell', address: 'B3', value: 'public' },
        { op: 'set_note', address: 'B2', text: 'check the number' },
        {
          op: 'set_data_validation',
          range: 'B2:B3',
          validation: { kind: 'list', values: ['yes', 'no'] },
        },
        { op: 'add_defined_name', name: 'Phone', ref: `${sheetName}!$B$2` },
      ]),
    )
    const applied = await run(['sheet', 'apply', path, '--ops', ops, '--json'])
    expect(applied.stderr + applied.stdout).not.toContain('"status":"error"')
    expect(applied.code).toBe(0)
  })
}

export function expectNoGiveaway(text: string, what: string): void {
  for (const giveaway of GIVEAWAYS) {
    expect(text, `${what} must not contain ${giveaway}`).not.toContain(giveaway)
  }
}

/** One transparent pixel: the picture's bytes carry no text, so what leaks is read from the names around it. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==',
  'base64',
)

function anchor(from: [number, number], to: [number, number], body: string) {
  return (
    `<xdr:twoCellAnchor><xdr:from><xdr:col>${from[0]}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${from[1]}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
    `<xdr:to><xdr:col>${to[0]}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${to[1]}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>${body}<xdr:clientData/></xdr:twoCellAnchor>`
  )
}

const PIC = (id: number, name: string, descr: string, title: string) =>
  `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${id}" name="${name}" descr="${descr}" title="${title}"/><xdr:cNvPicPr/></xdr:nvPicPr>` +
  `<xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
  `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>`

/**
 * A drawing on the sheet: a picture over the hidden cell B2 whose name, title
 * and alt text are the phone number and words about it, a text box over B2:C2
 * with the number as its text, and a picture over A1 that has nothing to do
 * with the cell.
 */
export async function withDrawing(file: string): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(file))
  const NS =
    'xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  const drawing =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr ${NS}>` +
    anchor([1, 1], [2, 2], PIC(2, `Phone ${SECRET}`, `ID scan of ${SECRET}`, 'passport')) +
    anchor(
      [1, 1],
      [3, 2],
      `<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="3" name="ssn-text-box" descr="${SECRET}"/><xdr:cNvSpPr txBox="1"/></xdr:nvSpPr>` +
        `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>` +
        `<xdr:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${SECRET}</a:t></a:r></a:p></xdr:txBody></xdr:sp>`,
    ) +
    anchor([0, 0], [1, 1], PIC(4, 'Logo', 'company logo', 'logo')) +
    '</xdr:wsDr>'
  zip.file('xl/drawings/drawing1.xml', drawing)
  zip.file(
    'xl/drawings/_rels/drawing1.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>',
  )
  zip.file('xl/media/image1.png', PNG_1X1)
  const relsPath = 'xl/worksheets/_rels/sheet1.xml.rels'
  const rels = await zip.file(relsPath)!.async('string')
  zip.file(
    relsPath,
    rels.replace(
      '</Relationships>',
      '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>',
    ),
  )
  const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
  expect(sheet).toContain('<legacyDrawing')
  zip.file(
    'xl/worksheets/sheet1.xml',
    sheet.replace('<legacyDrawing', '<drawing r:id="rId9"/><legacyDrawing'),
  )
  const types = await zip.file('[Content_Types].xml')!.async('string')
  zip.file(
    '[Content_Types].xml',
    types
      .replace(
        '<Default Extension="xml"',
        '<Default Extension="png" ContentType="image/png"/><Default Extension="xml"',
      )
      .replace(
        '</Types>',
        '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>',
      ),
  )
  writeFileSync(file, await zip.generateAsync({ type: 'uint8array' }))
  return file
}
