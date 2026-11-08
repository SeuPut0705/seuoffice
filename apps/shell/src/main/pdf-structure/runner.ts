/**
 * Runs structure jobs, one process per job (spec: structure extraction and
 * conversion run outside the shell main process, which must never stall on a
 * large document). The process is ended as soon as its job answers, fails,
 * is cancelled, or its owner (a pdf view) goes away; a job never outlives
 * the app.
 *
 * Electron-free: the process factory is injected (utilityProcess.fork in the
 * app, a fake in the tests).
 */
import type { PdfStructureFailure } from '../../../../pdf/src/shared/ipc'
import { failureOf, parseChildMessage, type ProcessSetup, type StructureJob } from './protocol'

/** the part of Electron's UtilityProcess the runner uses */
export interface JobProcess {
  postMessage(message: unknown): void
  /** true when the process was signalled */
  kill(): boolean
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
}

export type SpawnJobProcess = () => JobProcess

export type JobRunOutcome = { ok: true; value: unknown } | PdfStructureFailure

/** concurrent jobs one view may run; more answer 'busy' */
export const MAX_JOBS_PER_OWNER = 4

interface Running {
  owner: number
  jobId: string
  finish: (outcome: JobRunOutcome) => void
}

export class StructureJobRunner {
  private readonly jobs = new Map<string, Running>()

  constructor(
    private readonly spawn: SpawnJobProcess,
    private readonly setup: () => ProcessSetup,
    private readonly maxPerOwner = MAX_JOBS_PER_OWNER,
  ) {}

  /**
   * Start `job` in a new process for `owner` (a webContents id). Resolves
   * once with the answer; never rejects.
   */
  run(
    owner: number,
    jobId: string,
    job: StructureJob,
    onProgress?: (done: number, total: number) => void,
  ): Promise<JobRunOutcome> {
    const key = `${owner}:${jobId}`
    if (this.jobs.has(key)) {
      return Promise.resolve({ ok: false, error: 'busy', message: 'job id already running' })
    }
    if (this.running(owner) >= this.maxPerOwner) {
      return Promise.resolve({ ok: false, error: 'busy', message: 'too many jobs for this view' })
    }
    let child: JobProcess
    let setup: ProcessSetup
    try {
      setup = this.setup()
      child = this.spawn()
    } catch (err) {
      return Promise.resolve({
        ok: false,
        error: 'failed',
        message: `could not start the job process: ${err instanceof Error ? err.message : String(err)}`,
      })
    }

    return new Promise<JobRunOutcome>((resolve) => {
      let settled = false
      let exited = false
      const finish = (outcome: JobRunOutcome): void => {
        if (settled) return
        settled = true
        this.jobs.delete(key)
        // the process ends with its job, whatever ended the job
        if (!exited) {
          try {
            child.kill()
          } catch {
            /* already gone */
          }
        }
        resolve(outcome)
      }
      this.jobs.set(key, { owner, jobId, finish })

      child.on('message', (raw) => {
        const msg = parseChildMessage(raw)
        if (!msg || settled) return
        if (msg.type === 'progress') onProgress?.(msg.done, msg.total)
        else if (msg.type === 'result') finish({ ok: true, value: msg.value })
        else finish(failureOf(msg))
      })
      child.on('exit', (code) => {
        exited = true
        finish({
          ok: false,
          error: 'process-exited',
          message: `job process exited with code ${code} before answering`,
        })
      })
      try {
        child.postMessage({ type: 'run', setup, job })
      } catch (err) {
        finish({
          ok: false,
          error: 'failed',
          message: `could not hand the job over: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    })
  }

  /** kill the job's process; its run() answers 'cancelled'. False when no such job runs */
  cancel(owner: number, jobId: string): boolean {
    const job = this.jobs.get(`${owner}:${jobId}`)
    if (!job) return false
    job.finish({ ok: false, error: 'cancelled' })
    return true
  }

  /** cancel every job of one owner (its tab closed); returns how many */
  cancelOwner(owner: number): number {
    let n = 0
    for (const job of [...this.jobs.values()]) {
      if (job.owner !== owner) continue
      job.finish({ ok: false, error: 'cancelled', message: 'the document closed' })
      n++
    }
    return n
  }

  /** cancel everything (the app is quitting); returns how many */
  cancelAll(): number {
    const all = [...this.jobs.values()]
    for (const job of all) job.finish({ ok: false, error: 'cancelled', message: 'the app quit' })
    return all.length
  }

  /** jobs running, for one owner or in total */
  running(owner?: number): number {
    if (owner === undefined) return this.jobs.size
    let n = 0
    for (const job of this.jobs.values()) if (job.owner === owner) n++
    return n
  }
}
