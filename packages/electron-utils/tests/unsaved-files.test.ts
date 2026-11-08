import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  UNSAVED_CHANGES_MESSAGE,
  assertFileSaved,
  fileHasUnsavedChanges,
  setOpenFilesSource,
  withoutUnsavedFiles,
} from '../src/unsaved-files'

let dir: string
let open: string
let clean: string
let closed: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-unsaved-'))
  open = join(dir, 'plan.pptx')
  clean = join(dir, 'notes.md')
  closed = join(dir, 'closed.docx')
  for (const p of [open, clean, closed]) writeFileSync(p, 'x')
})
afterEach(() => {
  setOpenFilesSource(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('files open with unsaved changes', () => {
  it('blocks nothing when no host has said what is open (an editor running on its own)', async () => {
    expect(await fileHasUnsavedChanges(open)).toBe(false)
    await expect(assertFileSaved(open)).resolves.toBeUndefined()
    expect(await withoutUnsavedFiles([{ path: open }], (h) => h.path)).toEqual([{ path: open }])
  })

  it('names only the file that is open and dirty', async () => {
    setOpenFilesSource(() => [
      { filePath: open, dirty: true },
      { filePath: clean, dirty: false },
      // an untitled tab has no file to compare
      { dirty: true },
    ])
    expect(await fileHasUnsavedChanges(open)).toBe(true)
    expect(await fileHasUnsavedChanges(clean)).toBe(false)
    expect(await fileHasUnsavedChanges(closed)).toBe(false)
  })

  it('refuses the read with a message that says to save first', async () => {
    setOpenFilesSource(async () => [{ filePath: open, dirty: true }])
    await expect(assertFileSaved(open)).rejects.toThrow(UNSAVED_CHANGES_MESSAGE)
    expect(UNSAVED_CHANGES_MESSAGE).toMatch(/unsaved changes/i)
    expect(UNSAVED_CHANGES_MESSAGE).toMatch(/save/i)
    await expect(assertFileSaved(clean)).resolves.toBeUndefined()
  })

  it('matches the same file spelled another way', async () => {
    setOpenFilesSource(() => [{ filePath: open, dirty: true }])
    expect(await fileHasUnsavedChanges(join(dir, 'sub', '..', 'plan.pptx'))).toBe(true)
    if (process.platform === 'win32') {
      expect(await fileHasUnsavedChanges(open.toUpperCase())).toBe(true)
    }
  })

  it('drops the dirty files from a list and keeps the order of the rest', async () => {
    setOpenFilesSource(() => [{ filePath: open, dirty: true }])
    const hits = [{ path: clean }, { path: open }, { path: closed }]
    expect(await withoutUnsavedFiles(hits, (h) => h.path)).toEqual([
      { path: clean },
      { path: closed },
    ])
  })

  it('asks the host once for a whole list', async () => {
    let asked = 0
    setOpenFilesSource(() => {
      asked++
      return [{ filePath: open, dirty: true }]
    })
    await withoutUnsavedFiles([{ path: clean }, { path: open }, { path: closed }], (h) => h.path)
    expect(asked).toBe(1)
  })

  it('treats a host that cannot answer as unsaved, rather than reading on', async () => {
    setOpenFilesSource(() => {
      throw new Error('tab manager is gone')
    })
    expect(await fileHasUnsavedChanges(clean)).toBe(true)
    await expect(assertFileSaved(clean)).rejects.toThrow(UNSAVED_CHANGES_MESSAGE)
    expect(await withoutUnsavedFiles([{ path: clean }], (h) => h.path)).toEqual([])
  })

  it('is shared by every copy of this module in the process', async () => {
    setOpenFilesSource(() => [{ filePath: open, dirty: true }])
    // a second bundled copy finds the source through the process-wide key
    const holder = globalThis as unknown as Record<symbol, unknown>
    expect(typeof holder[Symbol.for('genoffice.open-files-source')]).toBe('function')
  })
})
