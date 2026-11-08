/**
 * pdf-structure-ipc.ts needs a running Electron, so its wiring is pinned by
 * reading the source (like subscription-lifetime.test.ts): jobs run in a
 * utilityProcess built as its own entry, and end with the tab and the app.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PDF_CHANNELS } from '../../pdf/src/shared/ipc'

const main = (file: string) => readFileSync(join(__dirname, '../src/main', file), 'utf8')

describe('pdf structure wiring', () => {
  const ipc = main('pdf-structure-ipc.ts')

  it('is registered once from the shell entry', () => {
    const index = main('index.ts')
    expect(index).toMatch(
      /import \{[^}]*\bregisterPdfStructureIpc\b[^}]*\} from '\.\/pdf-structure-ipc'/,
    )
    expect(index.match(/^registerPdfStructureIpc\(\)$/gm)).toHaveLength(1)
  })

  it("lends its runner to the PDF tools window, whose jobs end with that window's contents", () => {
    const index = main('index.ts')
    expect(index).toMatch(/runJob: runWindowJob,\s*cancelJob: cancelWindowJob,/)
    expect(ipc).toMatch(/export function runWindowJob\([\s\S]*?watch\(owner\)[\s\S]*?runner\.run\(/)
  })

  it('runs each job in a utility process built from its own entry', () => {
    expect(ipc).toContain("from './pdf-structure/pdf-structure-process?modulePath'")
    expect(ipc).toMatch(/utilityProcess\.fork\(processEntryPath/)
  })

  it("ends a view's jobs with the view and every job with the app", () => {
    expect(ipc).toMatch(/once\('destroyed',[\s\S]*?forgetOwner\(id\)/)
    expect(ipc).toMatch(/app\.on\('will-quit', \(\) => jobRunner\.cancelAll\(\)\)/)
    expect(ipc).toMatch(/process\.on\('exit', \(\) => jobRunner\.cancelAll\(\)\)/)
  })

  it('handles every structure and store channel', () => {
    const channels = Object.entries(PDF_CHANNELS).filter(
      ([key]) => /^(structure|store)/.test(key) && key !== 'structureProgress',
    )
    expect(channels.length).toBeGreaterThan(10)
    for (const [key] of channels) {
      expect(ipc).toContain(`ipcMain.handle(PDF_CHANNELS.${key},`)
    }
  })

  it("checks the view's grants with the pdf editor's own table", () => {
    expect(ipc).toContain('pdfPathGranted(owner, path)')
  })
})
