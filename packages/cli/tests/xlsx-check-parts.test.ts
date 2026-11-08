import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { xlsxBufferFromSheets } from '@genoffice/xlsx-gateway/gateway/csv-import'
import { checkWorkbook } from '../src/formats/xlsx-check'
import { run, tempDir } from './helpers'
const WORKBOOK = 'xl/workbook.xml'
const RELS = 'xl/_rels/workbook.xml.rels'
const SHEET = 'xl/worksheets/sheet1.xml'
async function fixture() {
  const zip = await JSZip.loadAsync(await xlsxBufferFromSheets([{ name: 'Data', rows: [] }]))
  zip.file(
    SHEET,
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="e"><f>1/0</f><v>#DIV/0!</v></c><c r="B1" t="inlineStr"><is><t>{{client}}</t></is></c></row></sheetData></worksheet>',
  )
  return zip
}
async function expectFindings(zip: JSZip) {
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  const before = Buffer.from(bytes)
  const result = await checkWorkbook(bytes)
  expect(result.sheets).toEqual(['Data'])
  expect(result.issues.map((issue) => issue.code)).toEqual(
    expect.arrayContaining(['formula_error', 'placeholder_left']),
  )
  expect(bytes).toEqual(before)
}
async function target(zip: JSZip, value: string) {
  zip.file(
    RELS,
    (await zip.file(RELS)!.async('string')).replace(
      /Target="worksheets\/sheet1.xml"/,
      `Target="${value}"`,
    ),
  )
}
describe('XLSX check discovers actual worksheet parts', () => {
  it.each([
    'worksheets/sheet1.xml',
    '/xl/worksheets/sheet1.xml',
    '../xl/worksheets/sheet1.xml',
    'worksheets/%73heet1.xml',
    'worksheets/sheet%201.xml',
  ])('finds existing issues through %s', async (value) => {
    const zip = await fixture()
    if (value.includes('%20')) {
      zip.file('xl/worksheets/sheet 1.xml', await zip.file(SHEET)!.async('string'))
      zip.remove(SHEET)
      const types = '[Content_Types].xml'
      zip.file(
        types,
        (await zip.file(types)!.async('string')).replace(
          '/xl/worksheets/sheet1.xml',
          '/xl/worksheets/sheet%201.xml',
        ),
      )
    }
    await target(zip, value)
    await expectFindings(zip)
  })
  it.each([
    { parts: [WORKBOOK] },
    { parts: [RELS] },
    { parts: [SHEET] },
    { parts: [WORKBOOK, RELS, SHEET] },
  ])('normalizes namespace prefixes on $parts', async ({ parts }) => {
    const zip = await fixture()
    for (const path of parts) {
      const xml = await zip.file(path)!.async('string')
      zip.file(
        path,
        xml.replace(/xmlns="/g, 'xmlns:x="').replace(/<(\/?)([A-Za-z][A-Za-z0-9]*)/g, '<$1x:$2'),
      )
    }
    await expectFindings(zip)
  })
  it.each([WORKBOOK, RELS, SHEET])(
    'fails instead of reporting clean when %s is missing',
    async (part) => {
      const zip = await fixture()
      zip.remove(part)
      await expect(checkWorkbook(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow()
    },
  )
  it('fails when the worksheet relationship does not exist', async () => {
    const zip = await fixture()
    zip.file(RELS, (await zip.file(RELS)!.async('string')).replace('Id="rId1"', 'Id="other"'))
    await expect(checkWorkbook(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow()
  })
  it('keeps a genuinely clean workbook clean', async () => {
    const bytes = await xlsxBufferFromSheets([{ name: 'Data', rows: [['Hello']] }])
    expect((await checkWorkbook(bytes)).issues).toEqual([])
  })
  it('reports findings through the real CLI and preserves the source', async () => {
    const zip = await fixture()
    await target(zip, '../xl/worksheets/sheet1.xml')
    const bytes = await zip.generateAsync({ type: 'nodebuffer' })
    const path = join(tempDir(), 'check.xlsx')
    writeFileSync(path, bytes)
    const result = await run(['sheet', 'check', path, '--json'])
    expect(result.code).toBe(0)
    expect(result.json().detail.issues.map((issue: { code: string }) => issue.code)).toContain(
      'formula_error',
    )
    expect(readFileSync(path)).toEqual(bytes)
  })
})
