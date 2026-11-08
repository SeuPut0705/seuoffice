import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiRunError } from '@genoffice/ai-provider'
import {
  HEADLESS_LEDGER_FILE,
  HEADLESS_LOCK_FILE,
  HEADLESS_LOCK_STALE_MS,
  HEADLESS_SUBSCRIPTION_WINDOW_MS,
  headlessSubscriptionUsage,
  runHeadlessSubscriptionCall,
} from '../src/headless-ledger'
import { tempDir } from './routing-helpers'

type Ledger = typeof import('../src/headless-ledger')

/**
 * A second copy of the module, with its own module state: what a separately
 * launched CLI process has. The only thing the two copies share is the files
 * in the data directory.
 */
async function otherProcess(): Promise<Ledger> {
  vi.resetModules()
  return (await import('../src/headless-ledger')) as Ledger
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const FAST = { pollMs: 5 }

function ledgerRuns(dir: string): number[] {
  return (JSON.parse(readFileSync(join(dir, HEADLESS_LEDGER_FILE), 'utf-8')) as { runs: number[] })
    .runs
}

afterEach(() => {
  vi.resetModules()
})

describe('headless subscription defaults', () => {
  it('counts the requests of the last hour, and caps none', async () => {
    expect(HEADLESS_SUBSCRIPTION_WINDOW_MS).toBe(60 * 60 * 1000)
    const ledger = await import('../src/headless-ledger')
    expect('HEADLESS_SUBSCRIPTION_MAX_PER_HOUR' in ledger).toBe(false)
  })
})

describe('one request at a time', () => {
  it('makes a second request wait for the first, across two processes', async () => {
    const dir = tempDir()
    const a = await otherProcess()
    const b = await otherProcess()
    expect(a.runHeadlessSubscriptionCall).not.toBe(b.runHeadlessSubscriptionCall)
    let running = 0
    let peak = 0
    const order: string[] = []
    const job = (name: string) => async () => {
      running++
      peak = Math.max(peak, running)
      order.push(`${name}:start`)
      await sleep(40)
      order.push(`${name}:end`)
      running--
      return name
    }
    const first = a.runHeadlessSubscriptionCall(dir, job('a'), FAST)
    await sleep(5)
    const second = b.runHeadlessSubscriptionCall(dir, job('b'), FAST)
    expect(await Promise.all([first, second])).toEqual(['a', 'b'])
    expect(peak).toBe(1)
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
    expect(existsSync(join(dir, HEADLESS_LOCK_FILE))).toBe(false)
  })

  it('serialises a burst that arrives at once, past what used to be the hourly cap', async () => {
    const dir = tempDir()
    let running = 0
    let peak = 0
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        runHeadlessSubscriptionCall(
          dir,
          async () => {
            running++
            peak = Math.max(peak, running)
            await sleep(5)
            running--
            return i
          },
          FAST,
        ),
      ),
    )
    expect(results).toEqual(Array.from({ length: 25 }, (_, i) => i))
    expect(peak).toBe(1)
    expect(ledgerRuns(dir)).toHaveLength(25)
  })

  it('frees the turn when the request fails, and still counts it', async () => {
    const dir = tempDir()
    await expect(
      runHeadlessSubscriptionCall(
        dir,
        async () => {
          throw new Error('codex crashed')
        },
        FAST,
      ),
    ).rejects.toThrow('codex crashed')
    expect(existsSync(join(dir, HEADLESS_LOCK_FILE))).toBe(false)
    expect(ledgerRuns(dir)).toHaveLength(1)
    expect(await runHeadlessSubscriptionCall(dir, async () => 'next', FAST)).toBe('next')
  })

  it('stops waiting when the caller aborts', async () => {
    const dir = tempDir()
    let release = () => {}
    const holder = runHeadlessSubscriptionCall(
      dir,
      () => new Promise<void>((resolve) => (release = resolve)),
      FAST,
    )
    await sleep(10)
    const controller = new AbortController()
    const run = vi.fn(async () => 'never')
    const waiting = runHeadlessSubscriptionCall(dir, run, { ...FAST, signal: controller.signal })
    await sleep(20)
    controller.abort()
    await expect(waiting).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
    release()
    await holder
    // the aborted waiter took no slot
    expect(ledgerRuns(dir)).toHaveLength(1)
  })

  it('gives up with a timeout when the turn never comes', async () => {
    const dir = tempDir()
    let release = () => {}
    const holder = runHeadlessSubscriptionCall(
      dir,
      () => new Promise<void>((resolve) => (release = resolve)),
      FAST,
    )
    await sleep(10)
    const error = await runHeadlessSubscriptionCall(dir, async () => 'never', {
      ...FAST,
      queueTimeoutMs: 30,
    }).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(AiRunError)
    expect((error as AiRunError).kind).toBe('timeout')
    release()
    await holder
  })
})

describe('a lock left behind by a crashed process', () => {
  const deadPid = 2 ** 30
  const lock = (dir: string, pid: number) =>
    writeFileSync(
      join(dir, HEADLESS_LOCK_FILE),
      JSON.stringify({ token: 'left-behind', pid, acquiredAt: Date.now() }),
    )

  it('is taken over at once when its process is gone', async () => {
    const dir = tempDir()
    lock(dir, deadPid)
    const started = Date.now()
    expect(
      await runHeadlessSubscriptionCall(dir, async () => 'ran', {
        ...FAST,
        isProcessAlive: (pid) => pid !== deadPid,
      }),
    ).toBe('ran')
    expect(Date.now() - started).toBeLessThan(HEADLESS_LOCK_STALE_MS)
    expect(existsSync(join(dir, HEADLESS_LOCK_FILE))).toBe(false)
  })

  it('is taken over when its heartbeat stays stopped, even if the pid is in use again', async () => {
    const dir = tempDir()
    lock(dir, process.pid)
    const old = new Date(Date.now() - HEADLESS_LOCK_STALE_MS - 5_000)
    utimesSync(join(dir, HEADLESS_LOCK_FILE), old, old)
    const started = Date.now()
    expect(
      await runHeadlessSubscriptionCall(dir, async () => 'ran', { ...FAST, heartbeatMs: 60 }),
    ).toBe('ran')
    // not on first sight: the holder gets one heartbeat to show it is still there
    expect(Date.now() - started).toBeGreaterThanOrEqual(50)
  })

  it('is left alone when the silent holder shows up again within a heartbeat', async () => {
    const dir = tempDir()
    lock(dir, process.pid)
    const lockPath = join(dir, HEADLESS_LOCK_FILE)
    const old = new Date(Date.now() - HEADLESS_LOCK_STALE_MS - 5_000)
    utimesSync(lockPath, old, old)
    const run = vi.fn(async () => 'ran')
    const waiting = runHeadlessSubscriptionCall(dir, run, {
      ...FAST,
      heartbeatMs: 1_000,
      queueTimeoutMs: 1_600,
    }).catch((err: unknown) => err)
    // the holder was only suspended (the machine slept): its heartbeat resumes
    await sleep(100)
    const now = new Date()
    utimesSync(lockPath, now, now)
    expect(await waiting).toMatchObject({ kind: 'timeout' })
    expect(run).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(lockPath, 'utf-8')).token).toBe('left-behind')
  })

  it('is taken over when its content is unreadable and its heartbeat stays stopped', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, HEADLESS_LOCK_FILE), '{not json')
    const old = new Date(Date.now() - HEADLESS_LOCK_STALE_MS - 5_000)
    utimesSync(join(dir, HEADLESS_LOCK_FILE), old, old)
    expect(
      await runHeadlessSubscriptionCall(dir, async () => 'ran', { ...FAST, heartbeatMs: 20 }),
    ).toBe('ran')
  })

  it('is respected while its process is alive and its heartbeat is fresh', async () => {
    const dir = tempDir()
    lock(dir, process.pid)
    const run = vi.fn(async () => 'ran')
    const error = await runHeadlessSubscriptionCall(dir, run, {
      ...FAST,
      queueTimeoutMs: 40,
    }).catch((err: unknown) => err)
    expect((error as AiRunError).kind).toBe('timeout')
    expect(run).not.toHaveBeenCalled()
    // the live holder's lock is untouched
    expect(JSON.parse(readFileSync(join(dir, HEADLESS_LOCK_FILE), 'utf-8')).token).toBe(
      'left-behind',
    )
  })

  it('lets exactly one of several waiters take a stale lock over at a time', async () => {
    const dir = tempDir()
    lock(dir, deadPid)
    let running = 0
    let peak = 0
    await Promise.all(
      Array.from({ length: 5 }, () =>
        runHeadlessSubscriptionCall(
          dir,
          async () => {
            running++
            peak = Math.max(peak, running)
            await sleep(5)
            running--
          },
          { ...FAST, isProcessAlive: (pid) => pid !== deadPid },
        ),
      ),
    )
    expect(peak).toBe(1)
    // nothing of the lock machinery is left in the directory
    expect(readdirSync(dir)).toEqual([HEADLESS_LEDGER_FILE])
  })

  it('keeps the lock fresh while a long request runs', async () => {
    const dir = tempDir()
    const lockPath = join(dir, HEADLESS_LOCK_FILE)
    let release = () => {}
    const holder = runHeadlessSubscriptionCall(
      dir,
      () => new Promise<void>((resolve) => (release = resolve)),
      // a lock goes stale after 400 ms here; the heartbeat must outrun that
      { ...FAST, staleMs: 400, heartbeatMs: 40 },
    )
    await sleep(700)
    const run = vi.fn(async () => 'second')
    const second = runHeadlessSubscriptionCall(dir, run, {
      ...FAST,
      staleMs: 400,
      heartbeatMs: 40,
    })
    await sleep(300)
    expect(run).not.toHaveBeenCalled()
    expect(existsSync(lockPath)).toBe(true)
    release()
    await holder
    expect(await second).toBe('second')
  })
})

describe('no hourly cap', () => {
  it('runs the 21st request of an hour, and more, across two processes', async () => {
    const dir = tempDir()
    const a = await otherProcess()
    const b = await otherProcess()
    const t0 = 1_800_000_000_000
    let clock = t0
    const options = { ...FAST, now: () => clock }
    // the old cap was 20 an hour; every request past it runs all the same
    for (let i = 0; i < 25; i++) {
      clock = t0 + i * 60_000
      const process = i % 2 === 0 ? a : b
      expect(await process.runHeadlessSubscriptionCall(dir, async () => i, options)).toBe(i)
    }
    expect(ledgerRuns(dir)).toHaveLength(25)
    expect(existsSync(join(dir, HEADLESS_LOCK_FILE))).toBe(false)
  })

  it('never answers headless-limit, even with a ledger full of this hour', async () => {
    const dir = tempDir()
    const t0 = 1_800_000_000_000
    const full = Array.from({ length: 500 }, (_, i) => t0 - i * 1_000)
    writeFileSync(join(dir, HEADLESS_LEDGER_FILE), JSON.stringify({ version: 1, runs: full }))
    const run = vi.fn(async () => 'ran')
    expect(await runHeadlessSubscriptionCall(dir, run, { ...FAST, now: () => t0 })).toBe('ran')
    expect(run).toHaveBeenCalledTimes(1)
    expect(ledgerRuns(dir)).toHaveLength(501)
  })

  it('keeps only the last hour in the ledger', async () => {
    const dir = tempDir()
    const t0 = 1_800_000_000_000
    let clock = t0
    const options = { ...FAST, now: () => clock }
    await runHeadlessSubscriptionCall(dir, async () => 1, options)
    clock = t0 + 10_000
    await runHeadlessSubscriptionCall(dir, async () => 2, options)
    clock = t0 + HEADLESS_SUBSCRIPTION_WINDOW_MS
    await runHeadlessSubscriptionCall(dir, async () => 3, options)
    expect(ledgerRuns(dir)).toEqual([t0 + 10_000, t0 + HEADLESS_SUBSCRIPTION_WINDOW_MS])
  })

  it('reports the requests of the last hour without taking a slot, and nothing more', async () => {
    const dir = tempDir()
    const t0 = 1_800_000_000_000
    let clock = t0
    const options = { ...FAST, now: () => clock }
    expect(headlessSubscriptionUsage(dir, options)).toEqual({ used: 0 })
    for (let i = 0; i < 21; i++) await runHeadlessSubscriptionCall(dir, async () => i, options)
    expect(headlessSubscriptionUsage(dir, options)).toEqual({ used: 21 })
    expect(ledgerRuns(dir)).toHaveLength(21)
    clock = t0 + HEADLESS_SUBSCRIPTION_WINDOW_MS
    expect(headlessSubscriptionUsage(dir, options)).toEqual({ used: 0 })
  })

  it('does not let a timestamp from the future count for longer than an hour', async () => {
    const dir = tempDir()
    const t0 = 1_800_000_000_000
    writeFileSync(
      join(dir, HEADLESS_LEDGER_FILE),
      JSON.stringify({ version: 1, runs: [t0 + 10 * 3_600_000] }),
    )
    expect(headlessSubscriptionUsage(dir, { now: () => t0 })).toEqual({ used: 1 })
    expect(await runHeadlessSubscriptionCall(dir, async () => 1, { ...FAST, now: () => t0 })).toBe(
      1,
    )
    expect(headlessSubscriptionUsage(dir, { now: () => t0 + 3_600_000 })).toEqual({ used: 0 })
  })

  it('creates the data directory when it does not exist yet', async () => {
    const dir = join(tempDir(), 'not', 'there', 'yet')
    expect(await runHeadlessSubscriptionCall(dir, async () => 'ran', FAST)).toBe('ran')
    expect(ledgerRuns(dir)).toHaveLength(1)
  })
})

describe('a damaged ledger', () => {
  const t0 = 1_800_000_000_000
  /** the file was last written ten minutes before t0 */
  const written = t0 - 10 * 60_000
  const DAMAGED = [
    ['cut off mid-write', '{"version":1,"runs":[1800000000000,18'],
    ['empty', ''],
    ['not JSON', 'runs: 3'],
    ['JSON without the list', '{"version":1}'],
    ['a list that is not a list', '{"version":1,"runs":"none"}'],
    ['a list with something that is not a time', '{"version":1,"runs":[1800000000000,"two"]}'],
    ['another JSON value', 'null'],
  ] as const

  function damage(dir: string, content: string, mtime = written): string {
    const path = join(dir, HEADLESS_LEDGER_FILE)
    writeFileSync(path, content)
    utimesSync(path, new Date(mtime), new Date(mtime))
    return path
  }

  it.each(DAMAGED)(
    'does not block the request, and gives way to a fresh ledger (%s)',
    async (_name, content) => {
      const dir = tempDir()
      damage(dir, content)
      const options = { ...FAST, now: () => t0 }
      // the count is only information now: what cannot be read counts as nothing
      expect(headlessSubscriptionUsage(dir, options)).toEqual({ used: 0 })
      const run = vi.fn(async () => 'ran')
      expect(await runHeadlessSubscriptionCall(dir, run, options)).toBe('ran')
      expect(run).toHaveBeenCalledTimes(1)
      expect(ledgerRuns(dir)).toEqual([t0])
      expect(readdirSync(dir)).toEqual([HEADLESS_LEDGER_FILE])
      expect(headlessSubscriptionUsage(dir, options)).toEqual({ used: 1 })
    },
  )

  it('is run past by every process', async () => {
    const dir = tempDir()
    damage(dir, '{"runs": [1, "two", nul')
    const a = await otherProcess()
    const b = await otherProcess()
    for (const process of [a, b]) {
      const run = vi.fn(async () => 'ran')
      const result = await process.runHeadlessSubscriptionCall(dir, run, {
        ...FAST,
        now: () => t0,
      })
      expect(result).toBe('ran')
      expect(run).toHaveBeenCalledTimes(1)
    }
    expect(ledgerRuns(dir)).toEqual([t0, t0])
  })

  it('is not told apart from a missing ledger: first use just runs', async () => {
    const dir = tempDir()
    expect(headlessSubscriptionUsage(dir)).toEqual({ used: 0 })
    expect(await runHeadlessSubscriptionCall(dir, async () => 'ran', FAST)).toBe('ran')
    expect(ledgerRuns(dir)).toHaveLength(1)
  })
})
