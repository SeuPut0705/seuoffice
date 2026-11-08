import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  errorMessageOf,
  failureOf,
  parseChildMessage,
  parseRunMessage,
  type ProcessSetup,
  type StructureJob,
} from '../src/main/pdf-structure/protocol'
import { StructureJobRunner, type JobProcess } from '../src/main/pdf-structure/runner'

/** a fake utilityProcess: records what it was sent and whether it was killed */
class FakeChild extends EventEmitter implements JobProcess {
  posted: unknown[] = []
  killed = false
  alive = true
  postMessage(message: unknown): void {
    this.posted.push(message)
  }
  kill(): boolean {
    if (!this.alive) return false
    this.killed = true
    this.alive = false
    // like Electron: a killed process reports its exit afterwards
    queueMicrotask(() => this.emit('exit', 1))
    return true
  }
  answer(message: unknown): void {
    this.emit('message', message)
  }
  crash(code = 3): void {
    this.alive = false
    this.emit('exit', code)
  }
}

const SETUP: ProcessSetup = { wasmPath: '/w/pdfium.wasm', ocrHelperPaths: ['/o/win-ocr.exe'] }
const JOB: StructureJob = { op: 'tree', source: { pdfPath: '/docs/a.pdf' } }

function makeRunner(max?: number) {
  const children: FakeChild[] = []
  const runner = new StructureJobRunner(
    () => {
      const c = new FakeChild()
      children.push(c)
      return c
    },
    () => SETUP,
    max,
  )
  return { runner, children }
}

describe('structure job protocol', () => {
  it('accepts well-formed child messages and drops the rest', () => {
    expect(parseChildMessage({ type: 'progress', done: 2, total: 5 })).toEqual({
      type: 'progress',
      done: 2,
      total: 5,
    })
    expect(parseChildMessage({ type: 'result', value: { a: 1 } })).toEqual({
      type: 'result',
      value: { a: 1 },
    })
    expect(
      parseChildMessage({
        type: 'error',
        error: 'page-range',
        message: 'x',
        validRange: { first: 1, last: 3 },
      }),
    ).toEqual({
      type: 'error',
      error: 'page-range',
      message: 'x',
      validRange: { first: 1, last: 3 },
    })
    // an unknown code is still an error, never a success
    expect(parseChildMessage({ type: 'error', error: 'weird' })).toEqual({
      type: 'error',
      error: 'failed',
      message: '',
    })
    for (const bad of [null, 1, 'x', [], {}, { type: 'progress', done: -1, total: 1 }]) {
      expect(parseChildMessage(bad)).toBeNull()
    }
  })

  it('checks the run message on the child side', () => {
    expect(parseRunMessage({ type: 'run', setup: SETUP, job: JOB })).not.toBeNull()
    expect(parseRunMessage({ type: 'run', setup: SETUP, job: { op: 'shell', source: {} } })).toBe(
      null,
    )
    expect(parseRunMessage({ type: 'run', setup: { wasmPath: 1 }, job: JOB })).toBeNull()
    expect(parseRunMessage({ type: 'other' })).toBeNull()
  })

  it('classifies what a job throws', () => {
    const load = Object.assign(new Error('locked'), {
      name: 'PdfLoadError',
      code: 'password-required',
    })
    expect(errorMessageOf(load).error).toBe('password-required')
    const range = Object.assign(new Error('range'), {
      name: 'PageRangeError',
      validRange: { first: 1, last: 4 },
    })
    expect(errorMessageOf(range)).toMatchObject({
      error: 'page-range',
      validRange: { first: 1, last: 4 },
    })
    const conflict = Object.assign(new Error('c'), { name: 'AssetConflictError' })
    expect(errorMessageOf(conflict).error).toBe('asset-conflict')
    const na = Object.assign(new Error('n'), { name: 'NotAvailableError' })
    expect(errorMessageOf(na).error).toBe('not-available')
    expect(errorMessageOf(new Error('boom'))).toEqual({
      type: 'error',
      error: 'failed',
      message: 'boom',
    })
    expect(failureOf({ type: 'error', error: 'corrupt', message: '' })).toEqual({
      ok: false,
      error: 'corrupt',
    })
  })
})

describe('StructureJobRunner', () => {
  it('hands the job over, forwards progress, answers once and ends the process', async () => {
    const { runner, children } = makeRunner()
    const progress: Array<[number, number]> = []
    const pending = runner.run(7, 'job1', JOB, (d, t) => progress.push([d, t]))
    const child = children[0]!
    expect(child.posted).toEqual([{ type: 'run', setup: SETUP, job: JOB }])
    child.answer({ type: 'progress', done: 1, total: 2 })
    child.answer({ type: 'result', value: { docHash: 'h' } })
    await expect(pending).resolves.toEqual({ ok: true, value: { docHash: 'h' } })
    expect(progress).toEqual([[1, 2]])
    expect(child.killed).toBe(true)
    expect(runner.running()).toBe(0)
  })

  it('cancel kills the child and answers cancelled', async () => {
    const { runner, children } = makeRunner()
    const pending = runner.run(7, 'job1', JOB)
    expect(runner.cancel(7, 'job1')).toBe(true)
    await expect(pending).resolves.toEqual({ ok: false, error: 'cancelled' })
    expect(children[0]!.killed).toBe(true)
    expect(children[0]!.alive).toBe(false)
    // a late answer from the dying process changes nothing
    children[0]!.answer({ type: 'result', value: 1 })
    expect(runner.cancel(7, 'job1')).toBe(false)
    expect(runner.running()).toBe(0)
  })

  it('only the owner can cancel its job', async () => {
    const { runner, children } = makeRunner()
    const pending = runner.run(7, 'job1', JOB)
    expect(runner.cancel(8, 'job1')).toBe(false)
    expect(children[0]!.killed).toBe(false)
    children[0]!.answer({ type: 'result', value: null })
    await pending
  })

  it('closing a view ends every job it runs, and only those', async () => {
    const { runner, children } = makeRunner()
    const a = runner.run(7, 'a', JOB)
    const b = runner.run(7, 'b', JOB)
    const other = runner.run(9, 'a', JOB)
    expect(runner.cancelOwner(7)).toBe(2)
    expect((await a).ok).toBe(false)
    expect((await b).ok).toBe(false)
    expect(children[0]!.killed && children[1]!.killed).toBe(true)
    expect(children[2]!.killed).toBe(false)
    expect(runner.running(9)).toBe(1)
    expect(runner.cancelAll()).toBe(1)
    await expect(other).resolves.toMatchObject({ ok: false, error: 'cancelled' })
    expect(children[2]!.killed).toBe(true)
    expect(runner.running()).toBe(0)
  })

  it('a process that dies without answering fails its job', async () => {
    const { runner, children } = makeRunner()
    const pending = runner.run(7, 'job1', JOB)
    children[0]!.crash(134)
    await expect(pending).resolves.toMatchObject({ ok: false, error: 'process-exited' })
    expect(children[0]!.killed).toBe(false)
  })

  it('passes a job error through', async () => {
    const { runner, children } = makeRunner()
    const pending = runner.run(7, 'job1', JOB)
    children[0]!.answer({ type: 'error', error: 'password-required', message: 'locked' })
    await expect(pending).resolves.toEqual({
      ok: false,
      error: 'password-required',
      message: 'locked',
    })
    expect(children[0]!.killed).toBe(true)
  })

  it('refuses a duplicate job id and too many jobs per view', async () => {
    const { runner, children } = makeRunner(2)
    const first = runner.run(7, 'a', JOB)
    await expect(runner.run(7, 'a', JOB)).resolves.toMatchObject({ error: 'busy' })
    const second = runner.run(7, 'b', JOB)
    await expect(runner.run(7, 'c', JOB)).resolves.toMatchObject({ error: 'busy' })
    expect(children).toHaveLength(2)
    runner.cancelAll()
    await Promise.all([first, second])
  })

  it('answers failed when the process cannot start', async () => {
    const runner = new StructureJobRunner(
      () => {
        throw new Error('no fork')
      },
      () => SETUP,
    )
    await expect(runner.run(1, 'a', JOB)).resolves.toMatchObject({ ok: false, error: 'failed' })
    expect(runner.running()).toBe(0)
  })
})
