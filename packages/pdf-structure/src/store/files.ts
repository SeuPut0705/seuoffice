/**
 * File primitives of the result store: atomic whole-file JSON writes and
 * reads that never throw.
 *
 * A write goes to a uniquely named temp file beside the target, is flushed,
 * then renamed over the target. Readers therefore see either the previous
 * entry or the new one, never a torn file, and two processes writing the same
 * entry end with whichever rename came last.
 *
 * Windows refuses a rename onto a file that any process has open, and a
 * reader polling the store (the app while the terminal command writes) keeps
 * the target open often enough to starve that rename for seconds. An open
 * file can still be renamed away (Node opens files with delete sharing), so
 * when the rename is refused the writer moves the old entry aside and renames
 * the new one into the freed name. Writers of one entry take turns through a
 * lock file beside it; the lock also tells a reader that finds the entry
 * missing in that instant to look again.
 */
import { randomBytes } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { link, mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/**
 * A store write failed (disk full, permissions, a file in the way). The job
 * that hit it stops and reports it (spec "보관소 쓰기 실패"). The entry that
 * was there before the failed write is left as it was.
 */
export class StoreWriteError extends Error {
  readonly code = 'store-write-failed' as const
  /** Node error code of the cause (ENOSPC, EACCES, ENOTDIR, …), 'unknown' without one */
  readonly errno: string
  readonly path: string

  constructor(path: string, cause: unknown) {
    const errno = (cause as NodeJS.ErrnoException | undefined)?.code ?? 'unknown'
    super(`result store write failed (${errno}): ${path}`, { cause })
    this.name = 'StoreWriteError'
    this.errno = errno
    this.path = path
  }
}

/** temp and lock files start with a dot; listings skip them */
export const isTempName = (name: string): boolean => name.startsWith('.')

// Windows refuses a rename onto, or an open of, a file another process is
// replacing or has open
const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY'])
const READ_ATTEMPTS = 4
// a replace still refused after this is not a reader passing by
const REPLACE_BUDGET_MS = 5_000
// a lock this old belongs to a writer that died: a live one holds it for one replace
export const LOCK_STALE_MS = 10_000
const LOCK_WAIT_MS = 2 * LOCK_STALE_MS
// how long a reader waits for a writer to rename the new entry into the freed name
const GAP_WAIT_MS = 1_000
// cloud-sync folders and some filesystems refuse fsync; only durability suffers
const TOLERATED_SYNC = new Set(['EPERM', 'EACCES', 'EBUSY', 'EINVAL', 'ENOSYS', 'ENOTSUP'])

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const codeOf = (e: unknown): string => (e as NodeJS.ErrnoException | undefined)?.code ?? ''
const backoff = (attempt: number) => sleep(Math.min(5 * 2 ** attempt, 250) * (0.5 + Math.random()))
const lockBackoff = (attempt: number) =>
  sleep(Math.min(2 * 2 ** attempt, 50) * (0.5 + Math.random()))
const uniqueSuffix = () => `${process.pid}.${randomBytes(6).toString('hex')}`

/** the write lock of an entry: a dot file beside it */
export const lockPathOf = (path: string): string => join(dirname(path), `.${basename(path)}.lock`)

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const data = JSON.stringify(value)
  const dir = dirname(path)
  const tmp = join(dir, `.${basename(path)}.${uniqueSuffix()}.tmp`)
  let created = false
  try {
    await mkdir(dir, { recursive: true })
    const handle = await open(tmp, 'wx')
    created = true
    try {
      await handle.writeFile(data, 'utf8')
      await handle.sync().catch((e: unknown) => {
        if (!TOLERATED_SYNC.has(codeOf(e))) throw e
      })
    } finally {
      await handle.close()
    }
    const lock = await acquireLock(path)
    try {
      await replaceEntry(tmp, path)
    } finally {
      await releaseLock(lock)
    }
  } catch (e) {
    if (created) await unlink(tmp).catch(() => {})
    throw new StoreWriteError(path, e)
  }
}

/**
 * Put `tmp` in the place of `path`, holding the entry's lock. A refused
 * rename means the target is open somewhere: move it aside, rename into the
 * freed name, then delete the old entry (allowed while it is open).
 */
async function replaceEntry(tmp: string, path: string): Promise<void> {
  const aside = `${tmp.slice(0, -'.tmp'.length)}.old`
  // the old entry is still at `aside` because putting it back failed
  let stranded = false
  const deadline = Date.now() + REPLACE_BUDGET_MS
  for (let attempt = 0; ; attempt++) {
    let error: unknown
    try {
      await rename(tmp, path)
      if (stranded) await removeQuietly(aside)
      return
    } catch (e) {
      error = e
    }
    if (RETRYABLE.has(codeOf(error))) {
      error = undefined
      let moved = false
      try {
        await rename(path, aside)
        moved = true
      } catch (e) {
        if (codeOf(e) !== 'ENOENT') error = e
      }
      if (error === undefined) {
        try {
          await rename(tmp, path)
          if (moved || stranded) await removeQuietly(aside)
          return
        } catch (e) {
          error = e
          // a reader should find the old entry rather than none
          if (moved) {
            stranded = !(await rename(aside, path).then(
              () => true,
              () => false,
            ))
          }
        }
      }
    }
    if (!RETRYABLE.has(codeOf(error)) || Date.now() >= deadline) {
      if (stranded) await rename(aside, path).catch(() => {})
      throw error
    }
    await backoff(attempt)
  }
}

interface EntryLock {
  path: string
  /** what this writer wrote into the lock file */
  owner: string
}

/** take the entry's write lock, breaking one left behind by a dead writer */
async function acquireLock(path: string): Promise<EntryLock> {
  const lockPath = lockPathOf(path)
  const owner = JSON.stringify({ pid: process.pid, id: randomBytes(6).toString('hex') })
  const deadline = Date.now() + LOCK_WAIT_MS
  for (let attempt = 0; ; attempt++) {
    let handle: FileHandle
    try {
      handle = await open(lockPath, 'wx')
    } catch (e) {
      const code = codeOf(e)
      // EPERM/EACCES here: the previous lock is still being deleted
      if (code !== 'EEXIST' && !RETRYABLE.has(code)) throw e
      if (Date.now() >= deadline) throw e
      if (code !== 'EEXIST' || !(await breakStaleLock(lockPath))) await lockBackoff(attempt)
      continue
    }
    try {
      await handle.writeFile(owner, 'utf8')
    } catch (e) {
      await handle.close().catch(() => {})
      await unlink(lockPath).catch(() => {})
      throw e
    }
    await handle.close()
    return { path: lockPath, owner }
  }
}

async function releaseLock(lock: EntryLock): Promise<void> {
  // a writer that judged this lock stale may own the file by now
  const current = await readFile(lock.path, 'utf8').catch(() => undefined)
  if (current === lock.owner) await removeQuietly(lock.path)
}

/**
 * Move a dead writer's lock out of the way. True when the caller should try
 * to take the lock again at once.
 */
async function breakStaleLock(lockPath: string): Promise<boolean> {
  let seen: string
  let modifiedAt: number
  try {
    seen = await readFile(lockPath, 'utf8')
    modifiedAt = (await stat(lockPath)).mtimeMs
  } catch (e) {
    return codeOf(e) === 'ENOENT'
  }
  if (!isStaleLock(seen, modifiedAt)) return false
  // a rename moves one file once, so two writers cannot both break the same lock
  const grave = `${lockPath}.${uniqueSuffix()}.stale`
  try {
    await rename(lockPath, grave)
  } catch (e) {
    return codeOf(e) === 'ENOENT'
  }
  if ((await readFile(grave, 'utf8').catch(() => undefined)) !== seen) {
    // another writer took the lock between the look and the move: give it
    // back, without replacing a lock taken since (link refuses an existing name)
    await link(grave, lockPath).catch(() => {})
  }
  await removeQuietly(grave)
  return true
}

function isStaleLock(content: string, modifiedAt: number): boolean {
  if (Date.now() - modifiedAt > LOCK_STALE_MS) return true
  let pid: unknown
  try {
    pid = (JSON.parse(content) as { pid?: unknown }).pid
  } catch {
    // created a moment ago and not filled in yet
    return false
  }
  return typeof pid === 'number' && pid !== process.pid && !processAlive(pid)
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: it runs, under another account
    return codeOf(e) === 'EPERM'
  }
}

async function removeQuietly(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await unlink(path)
      return
    } catch (e) {
      if (!RETRYABLE.has(codeOf(e))) return
      await backoff(attempt)
    }
  }
}

/** a live writer holds the entry's lock, so a missing entry may be mid-replace */
async function writeUnderway(path: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(lockPathOf(path))).mtimeMs <= LOCK_STALE_MS
  } catch {
    return false
  }
}

/** parsed JSON, or undefined when the file is missing, unreadable or not JSON */
export async function readJson(path: string): Promise<unknown> {
  const started = Date.now()
  let lookedAgain = false
  for (let refused = 0; ;) {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as unknown
    } catch (e) {
      const code = codeOf(e)
      // a file being replaced can refuse an open for a moment on Windows
      if (RETRYABLE.has(code) && refused < READ_ATTEMPTS - 1) {
        await backoff(refused++)
        continue
      }
      if (code === 'ENOENT' && Date.now() - started < GAP_WAIT_MS) {
        // a writer has moved the old entry aside and is renaming the new one in
        if (await writeUnderway(path)) {
          lookedAgain = false
          await sleep(1 + Math.random() * 4)
          continue
        }
        // or it finished between the read and the lock check
        if (!lookedAgain) {
          lookedAgain = true
          continue
        }
      }
      return undefined
    }
  }
}

/** entry names of a folder, temp files left out; empty when it cannot be read */
export async function listNames(dir: string, kind: 'file' | 'dir'): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => !isTempName(e.name) && (kind === 'file' ? e.isFile() : e.isDirectory()))
      .map((e) => e.name)
  } catch {
    return []
  }
}

/** byte total of every file below a folder; files that vanish mid-walk count 0 */
export async function folderSize(dir: string): Promise<number> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) total += await folderSize(p)
    else if (e.isFile())
      total += await stat(p).then(
        (s) => s.size,
        () => 0,
      )
  }
  return total
}

/** a regular file is at `path`; false when it is missing or cannot be looked at */
export async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Delete one entry, taking turns with its writers through the entry lock. A
 * missing entry is not an error; any other failure is a StoreWriteError.
 */
export async function removeEntry(path: string): Promise<void> {
  try {
    const lock = await acquireLock(path)
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await unlink(path)
          return
        } catch (e) {
          const code = codeOf(e)
          if (code === 'ENOENT') return
          if (!RETRYABLE.has(code) || attempt >= READ_ATTEMPTS) throw e
          await backoff(attempt)
        }
      }
    } finally {
      await releaseLock(lock)
    }
  } catch (e) {
    // the entry's folder does not exist: nothing to delete
    if (codeOf(e) === 'ENOENT') return
    throw new StoreWriteError(path, e)
  }
}

export async function removeFolder(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch (e) {
    throw new StoreWriteError(dir, e)
  }
}
