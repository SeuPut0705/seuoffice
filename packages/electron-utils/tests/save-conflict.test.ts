import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const showMessageBox = vi.fn()
vi.mock('electron', () => ({ dialog: { showMessageBox } }))

import type { BrowserWindow } from 'electron'
import { LANGS } from '@genoffice/i18n'
import {
  confirmOverwriteIfConflicted,
  isModifiedSince,
  isPathOpenElsewhere,
  recordDiskState,
  setOpenPathProbe,
  shouldDeferAutoSave,
  type SaveDiskState,
} from '../src/save-conflict'
import { SAVE_CONFLICT_STRINGS, saveConflictLabels } from '../src/save-conflict-labels'

let dir: string
let doc: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-save-conflict-'))
  doc = join(dir, 'plan.docx')
  writeFileSync(doc, 'v1')
})

afterEach(() => {
  setOpenPathProbe(null)
  showMessageBox.mockReset()
  rmSync(dir, { recursive: true, force: true })
})

const openInBothPanes = (path: string) => path === doc

/** recorded state of the test file, which exists by construction */
const recordCurrent = async (): Promise<SaveDiskState> => {
  const state = await recordDiskState(doc)
  if (!state) throw new Error('test file disappeared')
  return state
}

const lastDialogOptions = (): Record<string, unknown> => {
  const call = showMessageBox.mock.lastCall as unknown[] | undefined
  expect(call).toBeDefined()
  return call![call!.length - 1] as Record<string, unknown>
}

describe('recordDiskState', () => {
  it('records the stat size and a sha256 of the file content', async () => {
    const state = await recordDiskState(doc)
    expect(state).toEqual({
      mtimeMs: expect.any(Number),
      size: 2,
      hash: createHash('sha256').update('v1').digest('hex'),
    })
  })

  it('answers null when the path is not a readable file', async () => {
    expect(await recordDiskState(join(dir, 'missing.docx'))).toBeNull()
  })
})

describe('isModifiedSince', () => {
  it('is not modified without a record', async () => {
    expect(await isModifiedSince(undefined, doc)).toBe(false)
  })

  it('is not modified when the file is gone (a missing file is not a copy conflict)', async () => {
    const recorded = await recordCurrent()
    rmSync(doc)
    expect(await isModifiedSince(recorded, doc)).toBe(false)
  })

  it('is not modified while mtime and size match, even with a stale hash', async () => {
    const recorded = await recordCurrent()
    expect(await isModifiedSince({ ...recorded, hash: 'stale' }, doc)).toBe(false)
  })

  it('is modified when the content hash differs', async () => {
    const recorded = await recordCurrent()
    writeFileSync(doc, 'v2 from the other pane')
    expect(await isModifiedSince(recorded, doc)).toBe(true)
  })

  it('is not modified when mtime differs but the hash still matches', async () => {
    const recorded = await recordCurrent()
    expect(await isModifiedSince({ ...recorded, mtimeMs: recorded.mtimeMs - 5000 }, doc)).toBe(
      false,
    )
  })
})

describe('open path probe', () => {
  it('is false while no host has supplied the tab list', () => {
    expect(isPathOpenElsewhere(doc)).toBe(false)
  })

  it('answers what the host-supplied probe says', () => {
    setOpenPathProbe(openInBothPanes)
    expect(isPathOpenElsewhere(doc)).toBe(true)
    expect(isPathOpenElsewhere(join(dir, 'other.docx'))).toBe(false)
  })

  it('unsetting the probe turns the answer back off', () => {
    setOpenPathProbe(openInBothPanes)
    setOpenPathProbe(null)
    expect(isPathOpenElsewhere(doc)).toBe(false)
  })

  it('treats a broken probe as “no sibling copy”, so no normal save is interrupted', () => {
    setOpenPathProbe(() => {
      throw new Error('tab manager is gone')
    })
    expect(isPathOpenElsewhere(doc)).toBe(false)
  })

  it('is shared by every bundled copy of this module through the process-wide key', () => {
    setOpenPathProbe(openInBothPanes)
    const holder = globalThis as unknown as Record<symbol, unknown>
    expect(typeof holder[Symbol.for('genoffice.open-path-probe')]).toBe('function')
  })
})

describe('shouldDeferAutoSave', () => {
  it('defers when the path is open in another pane and the disk changed', async () => {
    const recorded = await recordCurrent()
    writeFileSync(doc, 'v2 from the other pane')
    setOpenPathProbe(openInBothPanes)
    expect(await shouldDeferAutoSave(doc, recorded)).toBe(true)
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('does not defer for a path open nowhere else', async () => {
    const recorded = await recordCurrent()
    writeFileSync(doc, 'v2')
    setOpenPathProbe(() => false)
    expect(await shouldDeferAutoSave(doc, recorded)).toBe(false)
  })

  it('does not defer while the disk still matches the record', async () => {
    const recorded = await recordCurrent()
    setOpenPathProbe(openInBothPanes)
    expect(await shouldDeferAutoSave(doc, recorded)).toBe(false)
  })

  it('does not defer without a recorded state', async () => {
    writeFileSync(doc, 'v2')
    setOpenPathProbe(openInBothPanes)
    expect(await shouldDeferAutoSave(doc, undefined)).toBe(false)
  })
})

describe('confirmOverwriteIfConflicted', () => {
  it('asks nothing for a normal save: the path is not open elsewhere', async () => {
    const recorded = await recordCurrent()
    writeFileSync(doc, 'v2 from another program')
    await expect(
      confirmOverwriteIfConflicted({ parent: null, path: doc, recorded, lang: 'en' }),
    ).resolves.toBe('proceed')
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('asks nothing when no probe is installed', async () => {
    const recorded = await recordCurrent()
    writeFileSync(doc, 'v2')
    await expect(
      confirmOverwriteIfConflicted({ parent: null, path: doc, recorded, lang: 'en' }),
    ).resolves.toBe('proceed')
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('asks nothing when the sibling pane has not changed the disk', async () => {
    const recorded = await recordCurrent()
    setOpenPathProbe(openInBothPanes)
    await expect(
      confirmOverwriteIfConflicted({ parent: null, path: doc, recorded, lang: 'en' }),
    ).resolves.toBe('proceed')
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('cancels when the user keeps the changed disk copy', async () => {
    const recorded = await recordCurrent()
    writeFileSync(doc, 'v2 from the other pane')
    setOpenPathProbe(openInBothPanes)
    showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    await expect(
      confirmOverwriteIfConflicted({ parent: null, path: doc, recorded, lang: 'ko' }),
    ).resolves.toBe('cancel')
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(lastDialogOptions()).toMatchObject({
      type: 'warning',
      message: '이 문서가 다른 곳에서 바뀌었습니다.',
      detail: '그래도 저장하여 디스크의 변경 사항을 덮어쓸까요?',
      buttons: ['덮어쓰기', '취소'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
  })

  it('proceeds when the user chooses to overwrite', async () => {
    const recorded = await recordCurrent()
    writeFileSync(doc, 'v2 from the other pane')
    setOpenPathProbe(openInBothPanes)
    showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    await expect(
      confirmOverwriteIfConflicted({ parent: null, path: doc, recorded, lang: 'en' }),
    ).resolves.toBe('proceed')
    expect(lastDialogOptions()).toMatchObject({ buttons: ['Overwrite', 'Cancel'] })
  })

  it('shows the prompt over the given parent window', async () => {
    const recorded = await recordCurrent()
    writeFileSync(doc, 'v2 from the other pane')
    setOpenPathProbe(openInBothPanes)
    showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    const parent = { isDestroyed: () => false } as unknown as BrowserWindow
    await confirmOverwriteIfConflicted({ parent, path: doc, recorded, lang: 'en' })
    const call = showMessageBox.mock.lastCall as unknown[]
    expect(call[0]).toBe(parent)
    expect(call[1]).toMatchObject({ type: 'warning' })
  })

  it('drops a parent window that is already destroyed', async () => {
    const recorded = await recordCurrent()
    writeFileSync(doc, 'v2 from the other pane')
    setOpenPathProbe(openInBothPanes)
    showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    const parent = { isDestroyed: () => true } as unknown as BrowserWindow
    await confirmOverwriteIfConflicted({ parent, path: doc, recorded, lang: 'en' })
    const call = showMessageBox.mock.lastCall as unknown[]
    expect(call).toHaveLength(1)
    expect(call[0]).toMatchObject({ type: 'warning' })
  })
})

describe('save conflict labels', () => {
  it('covers every supported language', () => {
    for (const lang of LANGS) {
      expect(SAVE_CONFLICT_STRINGS[lang], `missing dictionary for ${lang}`).toBeDefined()
      const labels = saveConflictLabels(lang)
      for (const key of ['message', 'detail', 'overwrite', 'cancel'] as const) {
        expect(labels[key].trim().length, `${lang}.${key} is empty`).toBeGreaterThan(0)
      }
    }
  })

  it('keeps a localized copy of every string (no English fallback)', () => {
    const en = saveConflictLabels('en')
    for (const lang of LANGS) {
      if (lang === 'en') continue
      const labels = saveConflictLabels(lang)
      for (const key of ['message', 'detail', 'overwrite', 'cancel'] as const) {
        expect(labels[key], `${lang}.${key} is the English string`).not.toBe(en[key])
      }
    }
  })

  it('reads regional variants like ko-KR', () => {
    expect(saveConflictLabels('ko-KR')).toEqual(saveConflictLabels('ko'))
  })
})
