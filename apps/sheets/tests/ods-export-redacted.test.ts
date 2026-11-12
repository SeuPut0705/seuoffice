/**
 * An ODS copy cannot keep the marks that hide cells from the AI: the file
 * carries the cells and nothing that says they were hidden, so a model that
 * later reads it reads them. The export refuses such a workbook before it
 * writes anything. This runs the real spreadsheet engine over a real package.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { exportWorkbookAsOds } from '../src/main/ods-export'
import { XlsxSidecarClient } from '../src/main/xlsx-sidecar-client'
import { hiddenBook, SECRET } from '../../../packages/xlsx-gateway/tests/helpers/hidden-book'

function sidecarBinaryPath(): string {
  const executable = process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar'
  return fileURLToPath(
    new URL(`../native/xlsx-engine/target/release/${executable}`, import.meta.url),
  )
}

let directory: string
let client: XlsxSidecarClient

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ods-export-redacted-'))
  client = new XlsxSidecarClient(sidecarBinaryPath())
})

afterEach(async () => {
  client.stop()
  await rm(directory, { recursive: true, force: true })
})

async function bookOn(disk: string, record: 'part' | 'mirror' | 'both'): Promise<string> {
  const path = join(disk, `${record}.xlsx`)
  await writeFile(path, await hiddenBook({ record, strings: 'inline' }))
  return path
}

describe('exporting a workbook that hides cells from the AI as ODS', () => {
  it.each(['part', 'mirror', 'both'] as const)(
    'writes nothing, and asks for nothing to be confirmed (record: %s)',
    async (record) => {
      const sourcePath = await bookOn(directory, record)
      const targetPath = join(directory, 'copy.ods')
      let asked = false
      const outcome = await exportWorkbookAsOds({
        sidecar: client,
        sourcePath,
        targetPath,
        // a loss the person may accept is not what a mark is: nothing is asked
        confirmLoss: async () => {
          asked = true
          return true
        },
      })
      expect(outcome).toEqual({ status: 'redacted' })
      expect(asked).toBe(false)
      expect(existsSync(targetPath)).toBe(false)
      // and no half-written copy is left beside it
      expect(await readdir(directory)).toEqual([`${record}.xlsx`])
    },
  )

  it('refuses a record it cannot read, which hides everything', async () => {
    const sourcePath = await bookOn(directory, 'part')
    const zip = await JSZip.loadAsync(await readFile(sourcePath))
    zip.file('xl/gxRedactions.json', '{"version":1,')
    const damaged = join(directory, 'damaged.xlsx')
    await writeFile(damaged, await zip.generateAsync({ type: 'uint8array' }))
    const targetPath = join(directory, 'damaged.ods')
    const outcome = await exportWorkbookAsOds({
      sidecar: client,
      sourcePath: damaged,
      targetPath,
      confirmLoss: async () => true,
    })
    expect(outcome).toEqual({ status: 'redacted' })
    expect(existsSync(targetPath)).toBe(false)
  })

  it('still writes the copy of a workbook that hides nothing', async () => {
    const zip = await JSZip.loadAsync(await readFile(await bookOn(directory, 'part')))
    // the same workbook with its record taken out
    zip.remove('xl/gxRedactions.json')
    const plain = join(directory, 'plain.xlsx')
    await writeFile(plain, await zip.generateAsync({ type: 'uint8array' }))
    const targetPath = join(directory, 'plain.ods')
    const outcome = await exportWorkbookAsOds({
      sidecar: client,
      sourcePath: plain,
      targetPath,
      confirmLoss: async () => true,
    })
    expect(outcome.status).toBe('exported')
    const ods = await JSZip.loadAsync(await readFile(targetPath))
    expect(await ods.file('content.xml')!.async('string')).toContain(SECRET)
  })
})
