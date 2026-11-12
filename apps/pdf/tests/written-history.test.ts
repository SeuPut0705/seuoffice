import { describe, expect, it } from 'vitest'

import {
  MAX_WRITTEN_STEPS,
  NO_WRITTEN_STEPS,
  recordWritten,
  stepWrittenFile,
  writeInPlace,
  type NoUndoQuestion,
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
  /** how many times a file was asked to be written back */
  restores: number
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
    restores: 0,
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
        file.restores += 1
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

/** One change written in place by a person who goes on whatever is asked: the file before it
 *  is kept, then the file becomes `after` */
async function change(
  file: FakeFile,
  steps: WrittenSteps,
  after: Uint8Array,
  limits?: { bytes: number; steps: number },
): Promise<WrittenSteps> {
  const written = await writeInPlace(
    file.api,
    PATH,
    async () => {
      file.disk = after
    },
    { consent: { given: false }, confirm: () => true, limits },
  )
  if (written.status !== 'run') throw new Error(`the change was ${written.status}`)
  return recordWritten(steps, written.before, limits)
}

describe('the file kept around a page operation, for Undo and Redo', () => {
  it('reads it in slices, never as one whole-file message', async () => {
    const big = new Uint8Array(PDF_READ_CHUNK_BYTES + 5).fill(3)
    const file = fakeFile(big)

    let steps = await change(file, NO_WRITTEN_STEPS, bytesOf(1, 2))
    expect(steps.undo).toHaveLength(1)
    expect(steps.undo[0]!.byteLength).toBe(big.byteLength)

    const undone = await stepWrittenFile(file.api, PATH, steps, 'undo', { diskChanged: false })
    expect(undone.ok).toBe(true)
    if (undone.ok) steps = undone.steps
    expect(file.disk.byteLength).toBe(big.byteLength)
    const redone = await stepWrittenFile(file.api, PATH, steps, 'redo', { diskChanged: false })
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
      const result = await stepWrittenFile(file.api, PATH, steps, direction, { diskChanged: false })
      if (!result.ok) throw new Error(result.reason)
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

    const first = await stepWrittenFile(file.api, PATH, steps, 'undo', {
      diskChanged: false,
      limits,
    })
    expect(first.ok && [...file.disk]).toEqual([2, 2, 2, 2])
    const second = await stepWrittenFile(file.api, PATH, first.ok ? first.steps : steps, 'undo', {
      diskChanged: false,
      limits,
    })
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
    const written = await writeInPlace(file.api, PATH, async () => {}, {
      consent: { given: false },
      confirm: () => true,
      limits,
    })
    const before = written.status === 'run' ? written.before : undefined
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

    const undone = await stepWrittenFile(file.api, PATH, steps, 'undo', {
      diskChanged: false,
      limits,
    })
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

    expect(await stepWrittenFile(file.api, PATH, steps, 'undo', { diskChanged: false })).toEqual({
      ok: false,
      reason: 'failed',
      error: 'disk full',
    })
    expect([...file.disk]).toEqual([2])
  })

  it('asks for nothing to be written while the notice of a change on disk is up', async () => {
    const file = fakeFile(bytesOf(1))
    const steps = await change(file, NO_WRITTEN_STEPS, bytesOf(2))
    const outside = bytesOf(9, 9, 9)
    file.disk = outside

    for (const direction of ['undo', 'redo'] as const) {
      expect(
        await stepWrittenFile(file.api, PATH, { undo: steps.undo, redo: steps.undo }, direction, {
          diskChanged: true,
        }),
      ).toEqual({ ok: false, reason: 'disk-changed' })
    }
    expect(file.restores).toBe(0)
    expect(file.disk).toBe(outside)
  })

  it('says the file changed on disk when the main process refuses for that', async () => {
    const file = fakeFile(bytesOf(1))
    const steps = await change(file, NO_WRITTEN_STEPS, bytesOf(2))
    file.restoreAnswer = { ok: false, error: 'external-modified' }

    expect(await stepWrittenFile(file.api, PATH, steps, 'undo', { diskChanged: false })).toEqual({
      ok: false,
      reason: 'disk-changed',
    })
  })

  it('says the same when the file is no longer there to read', async () => {
    const file = fakeFile(bytesOf(1))
    const steps = await change(file, NO_WRITTEN_STEPS, bytesOf(2))
    file.api.readFileChunk = async () => {
      throw new Error('ENOENT: no such file or directory')
    }

    expect(await stepWrittenFile(file.api, PATH, steps, 'undo', { diskChanged: false })).toEqual({
      ok: false,
      reason: 'disk-changed',
    })
    expect(file.restores).toBe(0)
  })
})

/** The person asked about a change that cannot be undone: what they were asked, and their answer */
function person(answer: boolean) {
  const asked: NoUndoQuestion[] = []
  return {
    asked,
    confirm: (question: NoUndoQuestion) => {
      asked.push(question)
      return answer
    },
  }
}

/** A page operation that would leave `after` in the file, counting how often it was asked to write */
function operation(file: FakeFile, after: Uint8Array) {
  const op = {
    writes: 0,
    write: async () => {
      op.writes += 1
      file.disk = after
      return 'written' as const
    },
  }
  return op
}

describe('a page operation on a file too large to keep for Undo', () => {
  const limits = { bytes: 4, steps: MAX_WRITTEN_STEPS }
  const LARGE = [1, 2, 3, 4, 5, 6]

  it('asks before anything is written, naming the file size and the limit', async () => {
    const file = fakeFile(bytesOf(...LARGE))
    const op = operation(file, bytesOf(9))
    const asked: Array<NoUndoQuestion & { writesSoFar: number }> = []

    const out = await writeInPlace(file.api, PATH, op.write, {
      consent: { given: false },
      confirm: (question) => {
        asked.push({ ...question, writesSoFar: op.writes })
        return true
      },
      limits,
    })

    expect(asked).toEqual([{ fileBytes: 6, limitBytes: 4, writesSoFar: 0 }])
    expect(out).toEqual({ status: 'run', result: 'written', before: null })
    expect([...file.disk]).toEqual([9])
  })

  it('writes nothing and leaves the steps as they were when the person cancels', async () => {
    // one step from when the file was still small enough to keep
    const file = fakeFile(bytesOf(7))
    const steps = await change(file, NO_WRITTEN_STEPS, bytesOf(...LARGE), limits)
    expect(steps.undo).toHaveLength(1)
    const op = operation(file, bytesOf(9))
    const user = person(false)

    const out = await writeInPlace(file.api, PATH, op.write, {
      consent: { given: false },
      confirm: user.confirm,
      limits,
    })

    expect(out).toEqual({ status: 'declined', flushed: false })
    expect(user.asked).toHaveLength(1)
    expect(op.writes).toBe(0)
    expect(file.restores).toBe(0)
    expect([...file.disk]).toEqual(LARGE)
    // the step from before is still the way back
    const undone = await stepWrittenFile(file.api, PATH, steps, 'undo', {
      diskChanged: false,
      limits,
    })
    expect(undone.ok && [...file.disk]).toEqual([7])
  })

  it('asks again the next time after a cancel', async () => {
    const file = fakeFile(bytesOf(...LARGE))
    const user = person(false)
    const gate = { consent: { given: false }, confirm: user.confirm, limits }

    await writeInPlace(file.api, PATH, operation(file, bytesOf(8)).write, gate)
    await writeInPlace(file.api, PATH, operation(file, bytesOf(9)).write, gate)

    expect(user.asked).toHaveLength(2)
    expect([...file.disk]).toEqual(LARGE)
  })

  it('goes on after Continue and does not ask again for the same document', async () => {
    const file = fakeFile(bytesOf(...LARGE))
    const user = person(true)
    const gate = { consent: { given: false }, confirm: user.confirm, limits }

    const first = operation(file, bytesOf(2, 2, 2, 2, 2, 2, 2))
    expect(await writeInPlace(file.api, PATH, first.write, gate)).toMatchObject({ status: 'run' })
    const second = operation(file, bytesOf(3, 3, 3, 3, 3, 3, 3, 3))
    expect(await writeInPlace(file.api, PATH, second.write, gate)).toMatchObject({ status: 'run' })

    expect([first.writes, second.writes]).toEqual([1, 1])
    expect(user.asked).toEqual([{ fileBytes: 6, limitBytes: 4 }])
    expect([...file.disk]).toEqual([3, 3, 3, 3, 3, 3, 3, 3])

    // another document has not been agreed to
    const other = fakeFile(bytesOf(...LARGE))
    await writeInPlace(other.api, PATH, operation(other, bytesOf(9)).write, {
      consent: { given: false },
      confirm: user.confirm,
      limits,
    })
    expect(user.asked).toHaveLength(2)
  })

  it('never asks about a file that fits, and keeps it for Undo', async () => {
    const file = fakeFile(bytesOf(1, 2, 3, 4))
    const user = person(false)
    const op = operation(file, bytesOf(9))

    const out = await writeInPlace(file.api, PATH, op.write, {
      consent: { given: false },
      confirm: user.confirm,
      limits,
    })

    expect(user.asked).toEqual([])
    expect(op.writes).toBe(1)
    expect(out.status === 'run' && [...out.before!]).toEqual([1, 2, 3, 4])
  })

  it('does not ask when a change only pushes the oldest step out', async () => {
    const file = fakeFile(bytesOf(0))
    const user = person(false)
    const gate = { consent: { given: false }, confirm: user.confirm }
    let steps: WrittenSteps = NO_WRITTEN_STEPS
    for (let n = 1; n <= MAX_WRITTEN_STEPS + 2; n++) {
      const out = await writeInPlace(file.api, PATH, operation(file, bytesOf(n)).write, gate)
      if (out.status === 'run') steps = recordWritten(steps, out.before)
    }
    expect(steps.undo).toHaveLength(MAX_WRITTEN_STEPS)
    expect([...file.disk]).toEqual([MAX_WRITTEN_STEPS + 2])
    expect(user.asked).toEqual([])
  })
})

/** Edits waiting to be saved into `file`: a save that works leaves `saved` there */
function pendingEdits(file: FakeFile, saved: Uint8Array, works = true) {
  const pending = {
    saves: 0,
    fileBytes: file.disk.byteLength,
    save: async () => {
      pending.saves += 1
      if (works) file.disk = saved
      return works
    },
  }
  return pending
}

describe('a page operation while edits are waiting to be saved', () => {
  const limits = { bytes: 4, steps: MAX_WRITTEN_STEPS }
  const LARGE = [1, 2, 3, 4, 5, 6]

  it('saves them first, and keeps the saved file for Undo', async () => {
    const file = fakeFile(bytesOf(1))
    const pending = pendingEdits(file, bytesOf(1, 1))
    const user = person(false)
    const op = operation(file, bytesOf(9))

    const out = await writeInPlace(
      file.api,
      PATH,
      op.write,
      { consent: { given: false }, confirm: user.confirm, limits },
      pending,
    )

    expect([pending.saves, op.writes]).toEqual([1, 1])
    expect(out.status === 'run' && [...out.before!]).toEqual([1, 1])
    expect(user.asked).toEqual([])
  })

  it('asks before they are saved when the file is too large, and Cancel saves nothing', async () => {
    const file = fakeFile(bytesOf(...LARGE))
    const pending = pendingEdits(file, bytesOf(...LARGE, 7))
    const user = person(false)
    const op = operation(file, bytesOf(9))

    const out = await writeInPlace(
      file.api,
      PATH,
      op.write,
      { consent: { given: false }, confirm: user.confirm, limits },
      pending,
    )

    expect(out).toEqual({ status: 'declined', flushed: false })
    expect(user.asked).toEqual([{ fileBytes: 6, limitBytes: 4 }])
    expect([pending.saves, op.writes]).toEqual([0, 0])
    expect([...file.disk]).toEqual(LARGE)
  })

  it('asks once: Continue before the save also covers the write after it', async () => {
    const file = fakeFile(bytesOf(...LARGE))
    const pending = pendingEdits(file, bytesOf(...LARGE, 7))
    const user = person(true)
    const op = operation(file, bytesOf(9))

    const out = await writeInPlace(
      file.api,
      PATH,
      op.write,
      { consent: { given: false }, confirm: user.confirm, limits },
      pending,
    )

    expect(out).toEqual({ status: 'run', result: 'written', before: null })
    expect(user.asked).toHaveLength(1)
    expect([pending.saves, op.writes]).toEqual([1, 1])
  })

  it('writes nothing when they could not be saved', async () => {
    const file = fakeFile(bytesOf(1))
    const pending = pendingEdits(file, bytesOf(1, 1), false)
    const op = operation(file, bytesOf(9))

    const out = await writeInPlace(
      file.api,
      PATH,
      op.write,
      { consent: { given: false }, confirm: () => true, limits },
      pending,
    )

    expect(out).toEqual({ status: 'unsaved' })
    expect(op.writes).toBe(0)
    expect([...file.disk]).toEqual([1])
  })

  it('asks after the save when the save itself made the file too large', async () => {
    const file = fakeFile(bytesOf(1))
    const pending = pendingEdits(file, bytesOf(...LARGE))
    const user = person(false)
    const op = operation(file, bytesOf(9))

    const out = await writeInPlace(
      file.api,
      PATH,
      op.write,
      { consent: { given: false }, confirm: user.confirm, limits },
      pending,
    )

    // the edits are in the file; the page operation is not
    expect(out).toEqual({ status: 'declined', flushed: true })
    expect(user.asked).toEqual([{ fileBytes: 6, limitBytes: 4 }])
    expect(op.writes).toBe(0)
    expect([...file.disk]).toEqual(LARGE)
  })
})
