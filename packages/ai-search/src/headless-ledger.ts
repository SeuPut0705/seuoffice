/**
 * Subscription use from the automatic-call path (command line, MCP): one
 * request at a time, and a count of the last hour's requests.
 *
 * Every CLI command is its own process, so neither can live in memory. Both
 * are kept in the data directory: a lock file that one request holds for as
 * long as it runs, and a ledger of the start times of the last hour's
 * requests, read and written only while holding the lock.
 *
 * A process can die holding the lock. The holder refreshes the lock file's
 * modification time while it runs; a lock whose process is gone, or whose
 * heartbeat stopped and stays stopped, is taken over.
 *
 * There is no hourly cap: the count is information only (the capabilities
 * report shows it). So the ledger never stops a request. A ledger whose
 * content is damaged or that cannot be read counts as empty, and a request
 * whose start cannot be written down runs all the same.
 */

import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { AiRunError } from '@genoffice/ai-provider'

/** The span the count of requests covers: the last hour. */
export const HEADLESS_SUBSCRIPTION_WINDOW_MS = 60 * 60 * 1000
/** A lock not refreshed for this long belongs to a process that died or hung. */
export const HEADLESS_LOCK_STALE_MS = 60_000
/** How often the holder refreshes its lock; several beats fit in the stale time. */
export const HEADLESS_LOCK_HEARTBEAT_MS = 10_000
/** How often a waiting request looks at the lock again. */
export const HEADLESS_LOCK_POLL_MS = 250
/** How long a request waits for its turn before it gives up with a timeout. */
export const HEADLESS_QUEUE_TIMEOUT_MS = 30 * 60 * 1000

/** How long the file system may keep refusing the lock file before the request fails. */
const LOCK_DENIED_GRACE_MS = 5_000

/** Start times (epoch ms) of the requests of the last window, under the data directory. */
export const HEADLESS_LEDGER_FILE = 'headless-subscription-ledger.json'
/** Held by the one request that is running, under the data directory. */
export const HEADLESS_LOCK_FILE = 'headless-subscription.lock'

export interface HeadlessLimitOptions {
  windowMs?: number | undefined
  /** clock for the ledger; lock freshness always follows the file system's clock */
  now?: (() => number) | undefined
}

export interface HeadlessCallOptions extends HeadlessLimitOptions {
  staleMs?: number | undefined
  heartbeatMs?: number | undefined
  pollMs?: number | undefined
  queueTimeoutMs?: number | undefined
  /** stops the wait for a turn; a request that already started is the caller's to cancel */
  signal?: AbortSignal | undefined
  isProcessAlive?: ((pid: number) => boolean) | undefined
}

export interface HeadlessSubscriptionUsage {
  /** requests started in the last hour, as far as the ledger can tell */
  used: number
}

interface Limits {
  windowMs: number
  now: () => number
}

function limitsOf(options: HeadlessLimitOptions): Limits {
  return {
    windowMs: options.windowMs ?? HEADLESS_SUBSCRIPTION_WINDOW_MS,
    now: options.now ?? Date.now,
  }
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined
}

// ── ledger ──────────────────────────────────────────────────────────

const LEDGER_RENAME_ATTEMPTS = 5
const LEDGER_RENAME_RETRY_MS = 20

/** The request times a ledger file holds, or null when its content is not a ledger. */
function parseLedger(raw: string): number[] | null {
  let stored: unknown
  try {
    stored = JSON.parse(raw)
  } catch {
    return null
  }
  const runs: unknown =
    typeof stored === 'object' && stored !== null ? (stored as { runs?: unknown }).runs : undefined
  if (!Array.isArray(runs)) return null
  return runs.every((time) => typeof time === 'number' && Number.isFinite(time))
    ? (runs as number[])
    : null
}

/**
 * The request times of this window, oldest first. A missing file is first
 * use; a file that cannot be read or whose content is not a ledger counts as
 * empty too, since the count stops nothing and the next write replaces it.
 * A time in the future (the clock was set back) counts as now, so nothing
 * stays in the count for longer than a window.
 */
function readLedger(dir: string, limits: Limits): number[] {
  const now = limits.now()
  let raw: string
  try {
    raw = readFileSync(join(dir, HEADLESS_LEDGER_FILE), 'utf-8')
  } catch {
    return []
  }
  return (parseLedger(raw) ?? [])
    .map((time) => Math.min(time, now))
    .filter((time) => time > now - limits.windowMs)
    .sort((a, b) => a - b)
}

/**
 * Replaces the ledger whole or not at all: the new content goes to a
 * temporary file that is renamed over the old one, and nothing is ever
 * written in place, so neither a crash nor a refused rename can leave half a
 * ledger behind. A rename that keeps being refused leaves the old ledger as
 * it was; the request runs regardless.
 */
async function writeLedger(dir: string, runs: number[]): Promise<void> {
  const path = join(dir, HEADLESS_LEDGER_FILE)
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify({ version: 1, runs }))
    for (let attempt = 1; ; attempt++) {
      try {
        renameSync(temp, path)
        return
      } catch (err) {
        // Windows refuses the rename for a moment while a scanner holds the old file open
        const code = errorCode(err)
        const passing = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
        if (!passing || attempt >= LEDGER_RENAME_ATTEMPTS) throw err
        await sleep(LEDGER_RENAME_RETRY_MS, undefined)
      }
    }
  } catch {
    // the count is information only: a request is not refused for it
    removeIfExists(temp)
  }
}

/**
 * How many subscription requests the automatic-call path started in the last
 * hour. Information only: nothing is capped. Reads only; takes no slot and no
 * lock. A ledger that is damaged or cannot be read reports none.
 */
export function headlessSubscriptionUsage(
  dataDir: string,
  options: HeadlessLimitOptions = {},
): HeadlessSubscriptionUsage {
  return { used: readLedger(dataDir, limitsOf(options)).length }
}

// ── lock ────────────────────────────────────────────────────────────

interface LockState {
  /** file content as read; identifies one acquisition */
  raw: string
  pid: number | undefined
  mtimeMs: number
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists but belongs to someone else
    return errorCode(err) === 'EPERM'
  }
}

function readLock(path: string): LockState | null {
  try {
    const mtimeMs = statSync(path).mtimeMs
    const raw = readFileSync(path, 'utf-8')
    let pid: number | undefined
    try {
      const parsed: unknown = JSON.parse(raw)
      const value =
        typeof parsed === 'object' && parsed !== null ? (parsed as { pid?: unknown }).pid : 0
      if (typeof value === 'number' && Number.isInteger(value) && value > 0) pid = value
    } catch {
      /* written by a holder that died mid-write: only its age can tell */
    }
    return { raw, pid, mtimeMs }
  } catch {
    return null
  }
}

/**
 * Creates `path` only if it does not exist: `held` when another request has
 * it, `denied` when the file system refused without a lock being there.
 */
function createExclusive(path: string, content: string): 'created' | 'held' | 'denied' {
  try {
    writeFileSync(path, content, { flag: 'wx' })
    return 'created'
  } catch (err) {
    const code = errorCode(err)
    if (code === 'EEXIST') return 'held'
    // Windows answers EPERM / EBUSY while the previous holder's delete is still pending
    if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
      return readLock(path) ? 'held' : 'denied'
    }
    throw err
  }
}

function removeIfExists(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    /* already gone, or another process is removing it */
  }
}

interface LockOptions {
  staleMs: number
  heartbeatMs: number
  pollMs: number
  queueTimeoutMs: number
  signal: AbortSignal | undefined
  isProcessAlive: (pid: number) => boolean
}

/** A lock whose heartbeat looked stopped, remembered until the next look confirms it. */
interface Suspect {
  raw: string
  mtimeMs: number
  since: number
}

/**
 * Removes a lock whose holder is gone, and returns what the caller should
 * remember for its next look.
 *
 * A holder whose process no longer exists is gone for certain. A silent
 * heartbeat alone is not proof: the holder may have been suspended (the
 * machine slept) and be about to carry on. Such a lock is only suspected at
 * first, and taken over when one full heartbeat later it has still not moved.
 *
 * Two waiters can decide to remove the same lock; if both simply deleted it,
 * the slower one would delete the fresh lock the faster one had taken
 * meanwhile. So the removal is done under a second, momentary lock, and only
 * after reading the lock again and finding it unchanged.
 */
function takeOverStaleLock(
  path: string,
  o: LockOptions,
  suspect: Suspect | undefined,
): Suspect | undefined {
  const seen = readLock(path)
  if (!seen) return undefined
  const gone = seen.pid !== undefined && !o.isProcessAlive(seen.pid)
  if (!gone) {
    if (Date.now() - seen.mtimeMs <= o.staleMs) return undefined
    if (suspect?.raw !== seen.raw || suspect.mtimeMs !== seen.mtimeMs) {
      return { raw: seen.raw, mtimeMs: seen.mtimeMs, since: Date.now() }
    }
    if (Date.now() - suspect.since < o.heartbeatMs) return suspect
  }
  const guard = `${path}.takeover`
  if (createExclusive(guard, String(process.pid)) !== 'created') {
    // a waiter that died inside the few lines below left the guard behind
    const left = readLock(guard)
    if (left && Date.now() - left.mtimeMs > o.staleMs) removeIfExists(guard)
    return suspect
  }
  try {
    const again = readLock(path)
    if (again && again.raw === seen.raw && (gone || again.mtimeMs === seen.mtimeMs)) {
      removeIfExists(path)
    }
  } finally {
    removeIfExists(guard)
  }
  return undefined
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason
  return reason instanceof Error ? reason : new Error('The request was cancelled')
}

/** Waits for the lock and takes it. Returns the function that gives it back. */
async function acquireLock(dir: string, o: LockOptions): Promise<() => void> {
  const path = join(dir, HEADLESS_LOCK_FILE)
  const content = JSON.stringify({ token: randomUUID(), pid: process.pid, acquiredAt: Date.now() })
  const deadline = Date.now() + o.queueTimeoutMs
  let deniedSince: number | undefined
  let suspect: Suspect | undefined
  for (;;) {
    if (o.signal?.aborted) throw abortError(o.signal)
    let attempt = createExclusive(path, content)
    if (attempt === 'held') {
      suspect = takeOverStaleLock(path, o, suspect)
      attempt = createExclusive(path, content)
    }
    if (attempt === 'created') break
    if (attempt === 'denied') {
      // a pending delete clears within moments; a refusal that lasts is a directory we cannot write
      deniedSince ??= Date.now()
      if (Date.now() - deniedSince > LOCK_DENIED_GRACE_MS) {
        throw new Error(`Cannot create the lock file ${path}`)
      }
    } else {
      deniedSince = undefined
    }
    if (Date.now() >= deadline) {
      throw new AiRunError(
        'timeout',
        'Timed out waiting for another subscription request from the command line or an integration to finish',
      )
    }
    await sleep(o.pollMs, o.signal)
  }
  const heartbeat = setInterval(() => {
    // refresh only our own lock: after a takeover it is someone else's
    if (readLock(path)?.raw !== content) return
    try {
      const now = new Date()
      utimesSync(path, now, now)
    } catch {
      /* the lock is gone; release() will find out */
    }
  }, o.heartbeatMs)
  heartbeat.unref()
  return () => {
    clearInterval(heartbeat)
    if (readLock(path)?.raw === content) removeIfExists(path)
  }
}

// ── entry point ─────────────────────────────────────────────────────

/**
 * Runs one subscription request of the automatic-call path: waits until no
 * other such request is running (in this or any other process), notes its
 * start in the ledger, and runs it.
 *
 * There is no hourly cap, so nothing about the ledger stops a request. It
 * throws only when the turn never comes (AiRunError('timeout')), when the
 * wait is aborted, or when the lock file cannot be created. The start is
 * noted before the request runs, so a request that fails still counts: it
 * reached the subscription.
 */
export async function runHeadlessSubscriptionCall<T>(
  dataDir: string,
  run: () => Promise<T>,
  options: HeadlessCallOptions = {},
): Promise<T> {
  const limits = limitsOf(options)
  mkdirSync(dataDir, { recursive: true })
  const release = await acquireLock(dataDir, {
    staleMs: options.staleMs ?? HEADLESS_LOCK_STALE_MS,
    heartbeatMs: options.heartbeatMs ?? HEADLESS_LOCK_HEARTBEAT_MS,
    pollMs: options.pollMs ?? HEADLESS_LOCK_POLL_MS,
    queueTimeoutMs: options.queueTimeoutMs ?? HEADLESS_QUEUE_TIMEOUT_MS,
    signal: options.signal,
    isProcessAlive: options.isProcessAlive ?? defaultIsProcessAlive,
  })
  try {
    // nobody else writes the ledger while we hold the lock
    await writeLedger(dataDir, [...readLedger(dataDir, limits), limits.now()])
    return await run()
  } finally {
    release()
  }
}
