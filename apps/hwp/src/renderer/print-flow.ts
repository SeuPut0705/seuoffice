import type { AgentBridge } from './ai/agent-bridge'
import type { PrintJob, PrintMode, PrintPage } from '../shared/ipc'

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

export async function gatherPrintJob(
  bridge: Pick<AgentBridge, 'printPages'>,
  mode: PrintMode,
  onProgress: (done: number, total: number) => void,
): Promise<PrintJob> {
  const pages: PrintPage[] = []
  const images: string[] = []
  const known = new Map<string, number>()
  let total = 0
  for (let calls = 0; calls < MAX_PRINT_CALLS; calls++) {
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
    if (pages.length >= total) return { mode, pages, images }
    if (batch.pages.length === 0) break
  }
  throw new Error('the pages could not be drawn')
}
