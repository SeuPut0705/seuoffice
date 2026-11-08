/**
 * PDF document jobs started by an MCP tool call (`pdf_ai_read`,
 * `pdf_translate`). The call answers as soon as the job is running and the
 * job goes on inside the server process (spec §10); `pdf_status` reports it
 * from the result store. When the server ends, its jobs stop as
 * 'interrupted' and whatever they stored stays.
 */
import type { DocumentJobHandle } from '../../pdf-structure/src'

interface BackgroundJob {
  handle: Pick<DocumentJobHandle<unknown>, 'cancel'>
  /** settles once the job has ended and its outputs and record are written */
  finished: Promise<unknown>
}

const jobs = new Set<BackgroundJob>()

/** Keep a started job until it has finished. */
export function trackBackgroundJob(job: BackgroundJob): void {
  jobs.add(job)
  const forget = () => jobs.delete(job)
  job.finished.then(forget, forget)
}

/** Jobs this process is running in the background. */
export function backgroundJobCount(): number {
  return jobs.size
}

/**
 * Stop every background job ('interrupted') and wait, at most `timeoutMs`,
 * for each to write its final record (and, when it was started with
 * `partial`, the files of what it finished).
 */
export async function stopBackgroundJobs(timeoutMs = 10_000): Promise<void> {
  const running = [...jobs]
  if (!running.length) return
  for (const job of running) job.handle.cancel('interrupted')
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    Promise.allSettled(running.map((job) => job.finished)),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
      timer.unref()
    }),
  ])
  clearTimeout(timer)
}
