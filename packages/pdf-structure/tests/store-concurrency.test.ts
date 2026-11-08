/**
 * Result store under concurrent writers (spec §6 "동시 쓰기"): the app and the
 * terminal command may write the same entry at once. Every read must see a
 * whole entry from one writer, and the last write wins.
 */
import { spawn } from 'node:child_process'
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  readSync,
  readdirSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ResultStore, blockKeyString, translationBlockKeys } from '../src/store'
import { LOCK_STALE_MS, lockPathOf } from '../src/store/files'
import { sha256Hex } from '../src/tree'

const DOC = sha256Hex('doc')
const FP = sha256Hex('page')
// big enough that a torn write would be visible as truncated JSON
const FILLER = 'x'.repeat(64 * 1024)

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pdf-store-conc-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

interface Payload {
  version: number
  writer: string
  i: number
  filler: string
}

/** temp, aside and lock files left in a folder */
const leftovers = (dir: string) => readdirSync(dir).filter((name) => name.startsWith('.'))

function expectWhole(p: Payload | undefined, writers: string[], rounds: number) {
  expect(p).toBeDefined()
  expect(writers).toContain(p!.writer)
  expect(p!.i).toBeGreaterThanOrEqual(0)
  expect(p!.i).toBeLessThan(rounds)
  expect(p!.filler).toBe(FILLER)
}

describe('concurrent writers, one process', () => {
  it('Promise.all writes to the same entry leave one whole entry', async () => {
    const a = new ResultStore(root)
    const b = new ResultStore(root)
    const writers = ['a', 'b']
    const rounds = 15
    const reads: (Payload | undefined)[] = []
    await Promise.all([
      ...writers.flatMap((w) =>
        Array.from({ length: rounds }, (_, i) =>
          (w === 'a' ? a : b).writeAiReadPage(DOC, FP, {
            version: 1,
            writer: w,
            i,
            filler: FILLER,
          }),
        ),
      ),
      ...Array.from({ length: 20 }, async () => {
        const e = await a.readAiReadPage(DOC, FP)
        if (e) reads.push(e.payload as unknown as Payload)
      }),
    ])
    for (const r of reads) expectWhole(r, writers, rounds)
    const last = await b.readAiReadPage(DOC, FP)
    expectWhole(last?.payload as unknown as Payload, writers, rounds)
  })

  it('concurrent block writes of one translation all land', async () => {
    const store = new ResultStore(root)
    const keys = translationBlockKeys(
      Array.from({ length: 40 }, (_, i) => ({
        key: `b${i}`,
        runs: [{ kind: 'text' as const, text: `block ${i}` }],
        blockId: `b${i}`,
        page: 1,
        pageFingerprint: FP,
      })),
    )
    await store.writeTranslationMeta(DOC, 'en', { provider: 'codex', model: 'm' })
    await Promise.all(
      keys.map((key, i) =>
        store.writeTranslationBlock(DOC, 'en', { key, status: 'translated', text: `t${i}` }),
      ),
    )
    const en = await store.readTranslation(DOC, 'en')
    expect(en?.blocks.size).toBe(40)
    keys.forEach((k, i) => expect(en?.blocks.get(blockKeyString(k))?.text).toBe(`t${i}`))
  })
})

describe('concurrent writers, separate processes', () => {
  const pkgDir = resolve(import.meta.dirname, '..')
  const storeUrl = pathToFileURL(join(pkgDir, 'src', 'store', 'index.ts')).href

  function runWriter(script: string, writer: string, rounds: number): Promise<number> {
    return new Promise((done, fail) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', script, root, DOC, FP, writer, String(rounds)],
        { cwd: pkgDir, stdio: ['ignore', 'ignore', 'pipe'] },
      )
      let err = ''
      child.stderr.on('data', (d: Buffer) => (err += d.toString()))
      child.on('error', fail)
      child.on('exit', (code) => (code === 0 ? done(code) : fail(new Error(`${code}: ${err}`))))
    })
  }

  it('two processes writing the same entry leave a readable, whole entry', async () => {
    const script = join(root, 'writer.mjs')
    writeFileSync(
      script,
      [
        `import { ResultStore } from ${JSON.stringify(storeUrl)}`,
        `const [root, doc, fp, writer, rounds] = process.argv.slice(2)`,
        `const store = new ResultStore(root)`,
        `const filler = 'x'.repeat(64 * 1024)`,
        `for (let i = 0; i < Number(rounds); i++) {`,
        `  await store.writeAiReadPage(doc, fp, { version: 1, writer, i, filler })`,
        `  await store.writeJob(doc, { kind: 'ai-read', state: 'running', outputs: [writer] })`,
        `}`,
      ].join('\n'),
    )
    const rounds = 40
    const writers = ['app', 'cli']
    const reader = new ResultStore(root)
    let reading = true
    const reads: Payload[] = []
    const jobReads: string[][] = []
    // entries are only ever replaced here, so once seen one must never read as absent
    let vanished = 0
    const readLoop = (async () => {
      while (reading) {
        const e = await reader.readAiReadPage(DOC, FP)
        if (e) reads.push(e.payload as unknown as Payload)
        else if (reads.length > 0) vanished++
        const job = await reader.readJob(DOC, 'ai-read')
        if (job.state !== 'idle') jobReads.push(job.outputs)
        await new Promise((r) => setTimeout(r, 2))
      }
    })()
    try {
      await Promise.all(writers.map((w) => runWriter(script, w, rounds)))
    } finally {
      reading = false
      await readLoop
    }
    for (const r of reads) expectWhole(r, writers, rounds)
    expect(vanished).toBe(0)
    for (const o of jobReads) expect(o.length === 1 && writers.includes(o[0]!)).toBe(true)
    const last = await reader.readAiReadPage(DOC, FP)
    expectWhole(last?.payload as unknown as Payload, writers, rounds)
    // the last write of whichever writer finished last
    expect(last?.payload.i).toBe(rounds - 1)
    expect(leftovers(dirname(reader.aiReadPagePath(DOC, FP)))).toEqual([])
    expect(leftovers(dirname(reader.jobPath(DOC, 'ai-read')))).toEqual([])
  }, 60_000)
})

describe('replacing an entry that is open elsewhere', () => {
  it('succeeds while another handle holds the entry open; that handle keeps the old whole entry', async () => {
    const store = new ResultStore(root)
    await store.writeAiReadPage(DOC, FP, { version: 1, writer: 'a', i: 0, filler: FILLER })
    const path = store.aiReadPagePath(DOC, FP)
    const fd = openSync(path, 'r')
    try {
      // Windows refuses a rename onto an open file; the writer moves it aside instead
      await store.writeAiReadPage(DOC, FP, { version: 1, writer: 'b', i: 1, filler: FILLER })
      expect((await store.readAiReadPage(DOC, FP))?.payload.writer).toBe('b')
      const buf = Buffer.alloc(256 * 1024)
      const n = readSync(fd, buf, 0, buf.length, 0)
      const old = JSON.parse(buf.subarray(0, n).toString('utf8')) as { payload: Payload }
      expect(old.payload.writer).toBe('a')
    } finally {
      closeSync(fd)
    }
    expect(leftovers(dirname(path))).toEqual([])
  })
})

describe('entry write lock', () => {
  const entry = { version: 1, writer: 'w', i: 0, filler: FILLER }

  function placeLock(store: ResultStore, owner: object, ageMs = 0): string {
    const path = store.aiReadPagePath(DOC, FP)
    const lock = lockPathOf(path)
    mkdirSync(dirname(lock), { recursive: true })
    writeFileSync(lock, JSON.stringify(owner))
    if (ageMs > 0) {
      const at = (Date.now() - ageMs) / 1000
      utimesSync(lock, at, at)
    }
    return lock
  }

  function deadPid(): Promise<number> {
    return new Promise((done, fail) => {
      const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
      child.on('error', fail)
      child.on('exit', () => done(child.pid!))
    })
  }

  it('a lock left by a writer that died does not hold up the next write', async () => {
    const store = new ResultStore(root)
    placeLock(store, { pid: await deadPid(), id: 'dead' })
    const started = Date.now()
    await store.writeAiReadPage(DOC, FP, entry)
    expect(Date.now() - started).toBeLessThan(LOCK_STALE_MS / 2)
    expect((await store.readAiReadPage(DOC, FP))?.payload.writer).toBe('w')
    expect(leftovers(dirname(store.aiReadPagePath(DOC, FP)))).toEqual([])
  })

  it('a lock older than the stale age is broken even when its process id is in use', async () => {
    const store = new ResultStore(root)
    placeLock(store, { pid: process.pid, id: 'old' }, LOCK_STALE_MS + 5_000)
    await store.writeAiReadPage(DOC, FP, entry)
    expect((await store.readAiReadPage(DOC, FP))?.payload.writer).toBe('w')
    expect(leftovers(dirname(store.aiReadPagePath(DOC, FP)))).toEqual([])
  })

  it("a live writer's lock makes the next write wait its turn", async () => {
    const store = new ResultStore(root)
    const lock = placeLock(store, { pid: process.pid, id: 'live' })
    let done = false
    const write = store.writeAiReadPage(DOC, FP, entry).then(() => (done = true))
    await new Promise((r) => setTimeout(r, 150))
    expect(done).toBe(false)
    unlinkSync(lock)
    await write
    expect((await store.readAiReadPage(DOC, FP))?.payload.writer).toBe('w')
    expect(leftovers(dirname(store.aiReadPagePath(DOC, FP)))).toEqual([])
  })

  it('a reader that finds the entry missing mid-replace waits for the new one', async () => {
    const store = new ResultStore(root)
    await store.writeAiReadPage(DOC, FP, entry)
    const path = store.aiReadPagePath(DOC, FP)
    const aside = join(dirname(path), '.aside')
    // the moment between moving the old entry aside and renaming the new one in
    renameSync(path, aside)
    const lock = placeLock(store, { pid: process.pid, id: 'live' })
    setTimeout(() => {
      renameSync(aside, path)
      unlinkSync(lock)
    }, 50)
    expect((await store.readAiReadPage(DOC, FP))?.payload.writer).toBe('w')
  })

  it('a missing entry reads as absent at once when no live writer holds its lock', async () => {
    const store = new ResultStore(root)
    let started = Date.now()
    expect(await store.readAiReadPage(DOC, FP)).toBeNull()
    expect(Date.now() - started).toBeLessThan(200)
    placeLock(store, { pid: process.pid, id: 'old' }, LOCK_STALE_MS + 5_000)
    started = Date.now()
    expect(await store.readAiReadPage(DOC, FP)).toBeNull()
    expect(Date.now() - started).toBeLessThan(200)
  })
})
