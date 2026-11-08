import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { blankXlsxBuffer } from '@genoffice/xlsx-gateway/gateway/csv-import'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { xlsxSidecarPath } from '../src/resources'
import { run, tempDir } from './helpers'
describe('limited sparse workbook reads with the release sidecar', () => {
  it.skipIf(!xlsxSidecarPath())(
    'reads a row without requesting the full 100001-row range',
    async () => {
      const zip = await JSZip.loadAsync(await blankXlsxBuffer('Data'))
      zip.file(
        'xl/worksheets/sheet1.xml',
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:A100001"/><sheetData><row r="1"><c r="A1"><v>9</v></c></row><row r="100001"><c r="A100001"><v>11</v></c></row></sheetData></worksheet>',
      )
      const file = join(tempDir(), 'sparse.xlsx')
      writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }))
      const before = readFileSync(file)
      const r = await run(
        ['sheet', 'read', file, '--range', 'A1:A100001', '--max-rows', '1', '--json'],
        { env: { ...process.env, GENOFFICE_AUDIT_LOG: 'off' } },
      )
      expect(r.code).toBe(0)
      expect(r.json().detail).toMatchObject({
        rows: [[9]],
        rowsShown: 1,
        rowsTotal: 100001,
        range: 'A1:A1',
        truncated: true,
      })
      expect(readFileSync(file)).toEqual(before)
    },
  )
})
