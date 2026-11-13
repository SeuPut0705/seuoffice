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
    'asks first, and Cancel writes nothing (record: %s)',
    async (record) => {
      const sourcePath = await bookOn(directory, record)
      const targetPath = join(directory, 'copy.ods')
      let asked = false
      const outcome = await exportWorkbookAsOds({
        sidecar: client,
        sourcePath,
        targetPath,
        confirmLoss: async () => true,
        confirmHidden: async () => {
          asked = true
          return 'cancel'
        },
      })
      expect(outcome).toEqual({ status: 'redacted', choice: 'cancel' })
      expect(asked).toBe(true)
      expect(existsSync(targetPath)).toBe(false)
      // and no half-written copy is left beside it
      expect(await readdir(directory)).toEqual([`${record}.xlsx`])
    },
  )

  it('asks about a record it cannot read, which hides everything', async () => {
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
      confirmHidden: async () => 'xlsx',
    })
    expect(outcome).toEqual({ status: 'redacted', choice: 'xlsx' })
    expect(existsSync(targetPath)).toBe(false)
  })

  it.each(['part', 'mirror', 'both'] as const)(
    'writes the real values and no mark of any kind when asked to export without the marks (record: %s)',
    async (record) => {
      const sourcePath = await bookOn(directory, record)
      const targetPath = join(directory, 'copy.ods')
      const outcome = await exportWorkbookAsOds({
        sidecar: client,
        sourcePath,
        targetPath,
        confirmLoss: async () => true,
        confirmHidden: async () => 'export',
      })
      expect(outcome.status).toBe('exported')
      const ods = await JSZip.loadAsync(await readFile(targetPath))
      expect(await ods.file('content.xml')!.async('string')).toContain(SECRET)
      // no part, no defined name, no label: the file does not say anything was hidden
      for (const path of Object.keys(ods.files)) {
        expect(path).not.toMatch(/redact|gx/i)
        const text = await ods.file(path)?.async('string')
        expect(text ?? '', path).not.toMatch(/gxRedaction|client phone/)
      }
    },
  )

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
      confirmHidden: async () => {
        throw new Error('nothing is hidden: nothing to ask')
      },
    })
    expect(outcome.status).toBe('exported')
    const ods = await JSZip.loadAsync(await readFile(targetPath))
    expect(await ods.file('content.xml')!.async('string')).toContain(SECRET)
  })
})
