import { describe, expect, it } from 'vitest'

import {
  MAX_WRITTEN_STEPS,
  NO_WRITTEN_STEPS,
  readWrittenSnapshot,
  recordWritten,
  stepWrittenFile,
  type WrittenSteps,
} from '../src/renderer/written-history'
import { PDF_READ_CHUNK_BYTES } from '../src/shared/ipc'
import type { RestoreFileRequest, RestoreFileResult } from '../src/shared/ipc'

interface FakeFile {
  disk: Uint8Array
  /** paths asked for as one whole-file message */
  wholeReads: string[]
  /** the slices asked for, in order */
  slices: Array<{ start: number; end: number }>
  restoreAnswer: RestoreFileResult
  api: {
    readFile(path: string): Promise<ArrayBuffer>
    readFileChunk(
      path: string,
      start: number,
      end: number,
    ): Promise<{ data: Uint8Array; fileSize: number }>
    restoreFile(request: RestoreFileRequest): Promise<RestoreFileResult>
  }
}

/** A file behind the three calls the history could make, counting what each one carried */
function fakeFile(initial: Uint8Array): FakeFile {
  const file: FakeFile = {
    disk: initial,
    wholeReads: [],
    slices: [],
    restoreAnswer: { ok: true },
    api: {
      readFile: async (path) => {
        file.wholeReads.push(path)
        return file.disk.slice().buffer
      },
      readFileChunk: async (_path, start, end) => {
        file.slices.push({ start, end })
        return {
          data: file.disk.slice(start, Math.min(end, file.disk.length)),
          fileSize: file.disk.length,
        }
      },
      restoreFile: async ({ bytes }) => {
        if (file.restoreAnswer.ok) file.disk = new Uint8Array(bytes.slice(0))
        return file.restoreAnswer
      },
    },
  }
  return file
}

const PATH = '/docs/scan.pdf'
const bytesOf = (...values: number[]) => new Uint8Array(values)
const held = (steps: WrittenSteps) =>
  [...steps.undo, ...steps.redo].reduce((sum, each) => sum + each.byteLength, 0)

/** One change written in place: the file before it is kept, then the file becomes `after` */
async function change(
  file: FakeFile,
  steps: WrittenSteps,
  after: Uint8Array,
  limits?: { bytes: number; steps: number },
): Promise<WrittenSteps> {
  const before = await readWrittenSnapshot(file.api, PATH, limits)
  file.disk = after
  return recordWritten(steps, before, limits)
}

describe('the file kept around a page operation, for Undo and Redo', () => {
  it('reads it in slices, never as one whole-file message', async () => {
    const big = new Uint8Array(PDF_READ_CHUNK_BYTES + 5).fill(3)
    const file = fakeFile(big)

    let steps = await change(file, NO_WRITTEN_STEPS, bytesOf(1, 2))
    expect(steps.undo).toHaveLength(1)
    expect(steps.undo[0]!.byteLength).toBe(big.byteLength)

    const undone = await stepWrittenFile(file.api, PATH, steps, 'undo')
    expect(undone.ok).toBe(true)
    if (undone.ok) steps = undone.steps
    expect(file.disk.byteLength).toBe(big.byteLength)
    const redone = await stepWrittenFile(file.api, PATH, steps, 'redo')
    expect(redone.ok).toBe(true)

    expect(file.wholeReads).toEqual([])
    expect(file.slices.length).toBeGreaterThan(0)
    expect(Math.max(...file.slices.map((s) => s.end - s.start))).toBeLessThanOrEqual(
      PDF_READ_CHUNK_BYTES,
    )
  })

  it('undoes and redoes a change, one step at a time', async () => {
    const file = fakeFile(bytesOf(1))
    let steps = await change(file, NO_WRITTEN_STEPS, bytesOf(2, 2))
    steps = await change(file, steps, bytesOf(3, 3, 3))
    expect([steps.undo.length, steps.redo.length]).toEqual([2, 0])

    const walk = async (direction: 'undo' | 'redo') => {
      const result = await stepWrittenFile(file.api, PATH, steps, direction)
      if (!result.ok) throw new Error(result.error)
      steps = result.steps
      return [...file.disk]
    }
    expect(await walk('undo')).toEqual([2, 2])
    expect(await walk('undo')).toEqual([1])
    expect([steps.undo.length, steps.redo.length]).toEqual([0, 2])
    expect(await walk('redo')).toEqual([2, 2])
    expect(await walk('redo')).toEqual([3, 3, 3])
    expect([steps.undo.length, steps.redo.length]).toEqual([2, 0])
  })

  it('drops the oldest steps once the kept files pass the byte budget', async () => {
    const limits = { bytes: 10, steps: MAX_WRITTEN_STEPS }
    const file = fakeFile(bytesOf(0, 0, 0, 0))
    let steps: WrittenSteps = NO_WRITTEN_STEPS
    for (const n of [1, 2, 3]) steps = await change(file, steps, bytesOf(n, n, n, n), limits)

    // three changes of a 4-byte file do not fit in 10 bytes: the first one is gone
    expect(steps.undo).toHaveLength(2)
    expect(held(steps)).toBeLessThanOrEqual(limits.bytes)

    const first = await stepWrittenFile(file.api, PATH, steps, 'undo', limits)
    expect(first.ok && [...file.disk]).toEqual([2, 2, 2, 2])
    const second = await stepWrittenFile(
      file.api,
      PATH,
      first.ok ? first.steps : steps,
      'undo',
      limits,
    )
    expect(second.ok && [...file.disk]).toEqual([1, 1, 1, 1])
    // what the Undo button reads: nothing older is left to go back to
    expect(second.ok && second.steps.undo).toEqual([])
    expect(second.ok && held(second.steps)).toBeLessThanOrEqual(limits.bytes)
  })

  it('keeps no step for a file larger than the budget, and stops reading it', async () => {
    const limits = { bytes: 1024 * 1024, steps: MAX_WRITTEN_STEPS }
    const small = fakeFile(bytesOf(1))
    const earlier = await change(small, NO_WRITTEN_STEPS, bytesOf(2), limits)
    expect(earlier.undo).toHaveLength(1)

    const file = fakeFile(new Uint8Array(2 * PDF_READ_CHUNK_BYTES + 5))
    const before = await readWrittenSnapshot(file.api, PATH, limits)
    // not toBeNull: a failure would print sixteen million bytes
    expect(before === null).toBe(true)
    expect(file.wholeReads).toEqual([])
    expect(file.slices).toHaveLength(1)
    // a change that cannot be undone leaves nothing before it undoable either:
    // the older step would put back a file from two changes ago
    expect(recordWritten(earlier, before, limits)).toEqual({ undo: [], redo: [] })
  })

  it('stays inside the budget when the file an Undo replaces is the larger one', async () => {
    const limits = { bytes: 10, steps: MAX_WRITTEN_STEPS }
    const file = fakeFile(bytesOf(1, 1, 1, 1))
    let steps = await change(file, NO_WRITTEN_STEPS, bytesOf(2, 2, 2, 2), limits)
    steps = await change(file, steps, bytesOf(3, 3, 3, 3, 3, 3, 3, 3), limits)
    expect(held(steps)).toBe(8)

    const undone = await stepWrittenFile(file.api, PATH, steps, 'undo', limits)
    expect(undone.ok && [...file.disk]).toEqual([2, 2, 2, 2])
    // the 8-byte file now waits for Redo; with it, only 2 bytes are left for older steps
    expect(undone.ok && held(undone.steps)).toBeLessThanOrEqual(limits.bytes)
    expect(undone.ok && undone.steps.redo.map((each) => each.byteLength)).toEqual([8])
  })

  it('keeps at most ten steps of a small file', async () => {
    const file = fakeFile(bytesOf(0))
    let steps: WrittenSteps = NO_WRITTEN_STEPS
    for (let n = 1; n <= MAX_WRITTEN_STEPS + 2; n++) steps = await change(file, steps, bytesOf(n))
    expect(steps.undo).toHaveLength(MAX_WRITTEN_STEPS)
    expect([...steps.undo[0]!]).toEqual([2])
  })

  it('leaves the steps as they were when the file could not be written back', async () => {
    const file = fakeFile(bytesOf(1))
    const steps = await change(file, NO_WRITTEN_STEPS, bytesOf(2))
    file.restoreAnswer = { ok: false, error: 'disk full' }

    expect(await stepWrittenFile(file.api, PATH, steps, 'undo')).toEqual({
      ok: false,
      error: 'disk full',
    })
    expect([...file.disk]).toEqual([2])
  })
})
