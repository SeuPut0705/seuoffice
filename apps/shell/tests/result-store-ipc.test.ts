import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerResultStoreIpc } from '../src/main/result-store-ipc'
import { RESULT_STORE_CHANNELS } from '../src/shared/result-store-api'
import { ResultStore } from '../../../packages/pdf-structure/src/store'

type Handler = (event: unknown, ...args: unknown[]) => unknown

let userData: string

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'shell-result-store-'))
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

function register(dir: () => string): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  registerResultStoreIpc(
    {
      handle: (channel: string, handler: Handler) => {
        handlers.set(channel, handler)
      },
    } as never,
    dir,
  )
  return handlers
}

describe('result store IPC (shell main)', () => {
  it('registers exactly the size and delete-all channels', () => {
    expect([...register(() => userData).keys()].sort()).toEqual(
      [RESULT_STORE_CHANNELS.deleteAll, RESULT_STORE_CHANNELS.size].sort(),
    )
  })

  it('reports 0 before anything is stored', async () => {
    const h = register(() => userData)
    expect(await h.get(RESULT_STORE_CHANNELS.size)!({})).toBe(0)
  })

  it('measures and deletes <userData>/pdf-store, leaving the rest of userData alone', async () => {
    const store = new ResultStore(userData)
    const docHash = 'a'.repeat(64)
    await store.writeAiReadPage(docHash, 'page1', { version: 1, text: 'hello' })
    await store.writeTranslationMeta(docHash, 'ko', { provider: 'claude', model: 'm' })
    writeFileSync(join(userData, 'app-settings.json'), '{"keep":true}')
    mkdirSync(join(userData, 'other'))

    const h = register(() => userData)
    const before = (await h.get(RESULT_STORE_CHANNELS.size)!({})) as number
    expect(before).toBeGreaterThan(0)
    expect(before).toBe(await store.size())

    await h.get(RESULT_STORE_CHANNELS.deleteAll)!({})
    expect(await h.get(RESULT_STORE_CHANNELS.size)!({})).toBe(0)
    expect(await store.readAiReadPage(docHash, 'page1')).toBeNull()
    expect(readdirSync(userData).sort()).toEqual(['app-settings.json', 'other'])
  })

  it('reads the user-data folder at call time, not at registration', async () => {
    let dir = join(userData, 'not-ready')
    const h = register(() => dir)
    dir = userData
    await new ResultStore(userData).writeAiReadPage('b'.repeat(64), 'p', { version: 1 })
    expect(await h.get(RESULT_STORE_CHANNELS.size)!({})).toBeGreaterThan(0)
  })
})
