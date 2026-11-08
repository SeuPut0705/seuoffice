import type { AgentBridge } from './ai/agent-bridge'
import type { HwpApi, PrintJob, PrintMode, PrintPage, PrintResult } from '../shared/ipc'

/**
 * Gathering the pages for a PDF or a print: the plugin draws them a few at a time (each
 * call must finish well within the bridge's ten seconds), and every picture the pages
 * carry is kept once. A logo on every page of a long document is otherwise sent and
 * written once per page.
 */

/** A picture in a page, as the editor writes it into the SVG. */
const PICTURE = /\bhref="(data:image\/[^"]*)"/g

/** The page with its pictures moved into `images`, each picture once across the job. */
export function sharePictures(svg: string, images: string[], known: Map<string, number>): string {
  return svg.replace(PICTURE, (_, dataUrl: string) => {
    let index = known.get(dataUrl)
    if (index === undefined) {
      index = images.length
      images.push(dataUrl)
      known.set(dataUrl, index)
    }
    return `href="ieum-image:${index}"`
  })
}

/** Calls of printPages one job makes at most: a plugin that stops moving must not hang it. */
const MAX_PRINT_CALLS = 10_000

/** The error of a job stopped because an AI run took the document while it gathered pages. */
export const HELD_ERROR = 'an AI request is editing this document'

export async function gatherPrintJob(
  bridge: Pick<AgentBridge, 'printPages'>,
  mode: PrintMode,
  onProgress: (done: number, total: number) => void,
  /**
   * True while an AI run holds the document: its edits are not accepted yet and must not be
   * on a page. Asked before every batch and before the job is handed over, so a run that
   * starts while the pages are gathered stops the job.
   */
  isHeld: () => boolean,
): Promise<PrintJob> {
  const pages: PrintPage[] = []
  const images: string[] = []
  const known = new Map<string, number>()
  let total = 0
  for (let calls = 0; calls < MAX_PRINT_CALLS; calls++) {
    if (isHeld()) throw new Error(HELD_ERROR)
    const batch = await bridge.printPages(pages.length)
    // a page count that moved under the job (an edit while gathering) stops it: the pages
    // gathered so far no longer belong with the ones still to come
    if (calls > 0 && batch.pageCount !== total) {
      throw new Error('the document changed while printing')
    }
    total = batch.pageCount
    if (batch.from !== pages.length) throw new Error('pages came back out of order')
    for (const page of batch.pages) {
      pages.push({ ...page, svg: sharePictures(page.svg, images, known) })
    }
    onProgress(pages.length, total)
    if (pages.length >= total) {
      // the last batch may have been drawn after a run took the document
      if (isHeld()) throw new Error(HELD_ERROR)
      return { mode, pages, images }
    }
    if (batch.pages.length === 0) break
  }
  throw new Error('the pages could not be drawn')
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** What a print or PDF job needs of the app: required, so none can be left out. */
export interface PrintJobPorts {
  ready: boolean
  /** The app's one "an AI run holds the document" flag: the one its saves read. */
  isHeld: () => boolean
  /** True while a job is in flight; one job at a time. */
  printing: { current: boolean }
  bridge: Pick<AgentBridge, 'printPages'>
  api: Pick<HwpApi, 'printPages'>
}

/**
 * One print or PDF job: refused while the editor is not ready, an AI run holds the document
 * or another job is going; the pages are gathered with the held check (a run that starts
 * meanwhile stops the job); then handed to the main process. Nothing is dispatched once the
 * document is held.
 */
export async function runPrintJob(
  ports: PrintJobPorts,
  mode: PrintMode,
  onProgress: (done: number, total: number) => void,
  /** the PDF path Save As picked: no dialog then */
  path?: string,
): Promise<PrintResult> {
  if (!ports.ready) return { ok: false, error: 'the editor is not ready' }
  // the pages would show edits the person has not accepted
  if (ports.isHeld()) return { ok: false, error: HELD_ERROR }
  if (ports.printing.current) return { ok: false, error: 'already printing' }
  ports.printing.current = true
  try {
    const job = await gatherPrintJob(ports.bridge, mode, onProgress, ports.isHeld)
    return await (path === undefined
      ? ports.api.printPages(job)
      : ports.api.printPages(job, { path }))
  } catch (error) {
    return { ok: false, error: errorText(error) }
  } finally {
    ports.printing.current = false
  }
}
