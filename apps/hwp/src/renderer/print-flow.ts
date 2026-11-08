import type { AgentBridge } from './ai/agent-bridge'
import type { HoldState } from './ai/turn-proposal'
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

/** What the app knows of the AI run's hold: it is on now, and how many times it has turned on. */
export interface HoldWatch {
  isHeld: () => boolean
  /** Only ever grows; bumped each time the hold turns on (held or stranded). */
  epoch: () => number
}

/**
 * The app's one record of the AI run's hold on the document, fed by the panel's `onRunHold`:
 * what its saves, copies and exports read, what a print job watches, and what a panel that
 * must not edit meanwhile (the document check) draws itself from. A stranded run is never let
 * go of.
 */
export class HoldTracker implements HoldWatch {
  private held = false
  private stranded = false
  private turnedOn = 0
  private readonly listeners = new Set<() => void>()

  set(state: HoldState): void {
    const before = this.held
    if (state !== 'free') this.turnedOn += 1
    if (state === 'stranded') this.stranded = true
    this.held = this.stranded || state === 'held'
    if (this.held !== before) for (const listener of [...this.listeners]) listener()
  }

  isHeld(): boolean {
    return this.held
  }

  isStranded(): boolean {
    return this.stranded
  }

  epoch(): number {
    return this.turnedOn
  }

  /** `listener` is called each time the document turns held or free; the returned call stops it. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }
}

export async function gatherPrintJob(
  bridge: Pick<AgentBridge, 'printPages'>,
  mode: PrintMode,
  onProgress: (done: number, total: number) => void,
  /**
   * The AI run's hold on the document. A run that starts while the pages are gathered stops
   * the job, even when it has been taken back out again by the time a batch comes back: the
   * epoch moves every time the hold turns on, and the job holds the one it began with.
   */
  hold: HoldWatch,
): Promise<PrintJob> {
  const startedAt = hold.epoch()
  const changed = () => hold.isHeld() || hold.epoch() !== startedAt
  const pages: PrintPage[] = []
  const images: string[] = []
  const known = new Map<string, number>()
  let total = 0
  for (let calls = 0; calls < MAX_PRINT_CALLS; calls++) {
    if (changed()) throw new Error(HELD_ERROR)
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
    // a batch drawn while a run edited is not used, however the hold looks by now
    if (changed()) throw new Error(HELD_ERROR)
    onProgress(pages.length, total)
    if (pages.length >= total) {
      // the last batch may have been drawn after a run took the document
      if (changed()) throw new Error(HELD_ERROR)
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
  /** The app's one "an AI run holds the document" state: the one its saves read. */
  hold: HoldWatch
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
  if (ports.hold.isHeld()) return { ok: false, error: HELD_ERROR }
  if (ports.printing.current) return { ok: false, error: 'already printing' }
  ports.printing.current = true
  try {
    const job = await gatherPrintJob(ports.bridge, mode, onProgress, ports.hold)
    return await (path === undefined
      ? ports.api.printPages(job)
      : ports.api.printPages(job, { path }))
  } catch (error) {
    return { ok: false, error: errorText(error) }
  } finally {
    ports.printing.current = false
  }
}

/**
 * The app's side of the AI run's hold, made once per window: the one record of the hold and
 * the two things that must feed from or read it. The app builds all three from here, so a hold
 * the panel reports is the one saves, exports and print jobs see; none can be given another.
 */
export interface AiHoldWiring {
  /** the one record of the hold: what the app's saves, copies and exports read */
  tracker: HoldTracker
  /** the AI dock's `onRunHold`: tells the tracker */
  onRunHold: (state: HoldState) => void
  /** a print or PDF job's ports, with the tracker as their hold */
  printPorts: (ports: Omit<PrintJobPorts, 'hold'>) => PrintJobPorts
}

export function createAiHoldWiring(): AiHoldWiring {
  const tracker = new HoldTracker()
  return {
    tracker,
    onRunHold: (state) => tracker.set(state),
    printPorts: (ports) => ({ ...ports, hold: tracker }),
  }
}
