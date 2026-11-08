// @vitest-environment jsdom
/**
 * The web hwpApi in edit mode answers the host's save requests (`onHostSaveRequest`) through the
 * renderer's own save: every request settles with that save's outcome, overlapping ones included.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HwpApi, SaveMode } from '../src/shared/ipc'
import { installBridges } from '../src/web/bridge'

const memo = new Uint8Array(readFileSync(join(__dirname, 'fixtures/memo.hwp')))
const doc = { id: 'memo', fileName: 'memo.hwp', bytes: memo, virtualPath: '/web/memo/memo.hwp' }

const host = vi.hoisted(() => ({
  saveRequest: undefined as (() => Promise<void>) | undefined,
  saveToHost: vi.fn<(fileName: string, bytes: Uint8Array) => Promise<void>>(),
}))

vi.mock('@seuoffice/web-platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@seuoffice/web-platform')>()),
  editMode: () => true,
  documentByPath: () => doc,
  waitForDocument: async () => doc,
  reportOpened: () => {},
  reportDirty: () => {},
  saveToHost: host.saveToHost,
  onHostSaveRequest: (handler: () => Promise<void>) => (host.saveRequest = handler),
}))

/** The renderer's save (save-flow.ts): one at a time, begin, then commit the exported bytes */
function renderer(api: HwpApi): void {
  let running = Promise.resolve()
  api.onSaveRequest((_mode: SaveMode) => {
    running = running.then(async () => {
      const begin = await api.beginSave('saveAs')
      if (begin.ok && 'format' in begin) await api.commitSave(memo, [])
    })
  })
}

describe('host save requests in edit mode', () => {
  beforeAll(async () => {
    // the bridge installs window.hwpApi once per page, so the tests share one opened document
    installBridges()
    await window.hwpApi.readFile(doc.virtualPath)
    renderer(window.hwpApi)
  })
  beforeEach(() => host.saveToHost.mockReset())

  it('settles each of two overlapping requests after its own save', async () => {
    let release!: () => void
    host.saveToHost
      .mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
      .mockResolvedValueOnce(undefined)
    const first = host.saveRequest!()
    const second = host.saveRequest!()
    await vi.waitFor(() => expect(host.saveToHost).toHaveBeenCalledTimes(1))
    release()
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
    expect(host.saveToHost).toHaveBeenCalledTimes(2)
  }, 5_000)

  it("rejects with the host's reason and lets the next request save", async () => {
    host.saveToHost
      .mockRejectedValueOnce(new Error('disk full at host'))
      .mockResolvedValueOnce(undefined)
    await expect(host.saveRequest!()).rejects.toThrow('disk full at host')
    await expect(host.saveRequest!()).resolves.toBeUndefined()
  }, 5_000)
})
