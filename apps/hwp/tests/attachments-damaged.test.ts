/**
 * A chat attachment whose container the file parsers refuse is reported to the person in
 * the app's own words, in their language: not the parser's English sentence, and not what
 * the gate found in the file's tables.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getUiLang, setUiLang } from '@seuoffice/i18n'
import type { Lang } from '@seuoffice/i18n'

const handlers = new Map<string, (...args: never[]) => unknown>()

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  dialog: {},
  ipcMain: {
    handle: (channel: string, fn: (...args: never[]) => unknown) => handlers.set(channel, fn),
  },
  BrowserWindow: class {},
}))
// the real unsaved-files helper, by path: the package root reaches Electron
vi.mock('@seuoffice/electron-utils', async () => ({
  showOpenDialogWithMemory: vi.fn(),
  ...(await import('../../../packages/electron-utils/src/unsaved-files')),
}))

import { registerHwpAttachmentIpc } from '../src/main/attachments-ipc'
import { tm } from '../src/main/dialog-strings'

type ReadResult = { ok: boolean; text?: string; error?: string }
let dir: string
let langBefore: Lang

function read(path: string): Promise<ReadResult> {
  handlers.clear()
  registerHwpAttachmentIpc()
  const fn = handlers.get('hwp:files-read') as unknown as (
    e: unknown,
    path: string,
    offset: number,
    maxChars: number,
  ) => Promise<ReadResult>
  return fn({}, path, 0, 1000)
}

/** The Hangul-written fixture; `refused` has its header count one FAT sector more than it lists. */
function memo(refused: boolean): string {
  const bytes = new Uint8Array(readFileSync(join(__dirname, 'fixtures/memo.hwp')))
  if (refused) {
    const view = new DataView(bytes.buffer, bytes.byteOffset)
    view.setUint32(44, view.getUint32(44, true) + 1, true)
  }
  const path = join(dir, refused ? 'refused.hwp' : 'sound.hwp')
  writeFileSync(path, bytes)
  return path
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seuoffice-hwp-attach-damaged-'))
  langBefore = getUiLang()
})
afterEach(() => {
  setUiLang(langBefore)
  rmSync(dir, { recursive: true, force: true })
})

describe('hwp:files-read and an .hwp the compound-file gate refuses', () => {
  for (const lang of ['ko', 'en'] as const) {
    it(`says the file could not be read in the app's words (${lang})`, async () => {
      setUiLang(lang)
      const result = await read(memo(true))
      expect(result.ok).toBe(false)
      expect(result.error).toBe(tm('errParseFailed'))
      expect(result.error).not.toMatch(/compound file|sector|FAT/i)
    })
  }

  it('answers in Korean for a Korean interface', async () => {
    setUiLang('ko')
    expect((await read(memo(true))).error).toMatch(/[가-힣]/)
  })

  it('still reads the same document when its container is sound', async () => {
    const result = await read(memo(false))
    expect(result.ok).toBe(true)
    expect(result.text?.trim().length).toBeGreaterThan(0)
  })
})
