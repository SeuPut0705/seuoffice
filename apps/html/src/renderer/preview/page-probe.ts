import { readPageMeasure, type PageMeasure } from '../document/page-report'
import { isFromInspector, type PaperLayout, type ToInspector } from './inspector-protocol'

export interface PageProbeRequest {
  /** html-preview:// URL of this view (the copy the main process currently serves) */
  url: string
  /** parse-map version of that copy; an answer from any other copy is not about this text */
  version: number
  paper: PaperLayout
}

/** fonts and pictures get 4s inside the frame; the rest is the load itself */
const PROBE_TIMEOUT_MS = 12_000

/**
 * Lay the served copy out on paper in a frame of its own and measure it, so
 * the answer does not depend on which device the visible preview shows (and
 * asking never disturbs it). The frame is the page content box in both
 * directions: vw, vh and width queries resolve as on a printed page. Resolves
 * null when the frame does not answer for this version in time.
 */
export function probePages({ url, version, paper }: PageProbeRequest): Promise<PageMeasure | null> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe')
    // the document's scripts run (they may build the content) but get nothing beyond that
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('aria-hidden', 'true')
    frame.setAttribute('referrerpolicy', 'no-referrer')
    frame.tabIndex = -1
    frame.className = 'page-probe'
    frame.style.width = `${paper.width}px`
    frame.style.height = `${Math.ceil(paper.height)}px`
    let reloaded = false
    const post = (msg: ToInspector) => frame.contentWindow?.postMessage(msg, '*')
    const finish = (measure: PageMeasure | null) => {
      window.clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      frame.remove()
      resolve(measure)
    }
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || !isFromInspector(event.data)) return
      const msg = event.data
      if (msg.type === 'gx:ready') {
        if (msg.version !== version) {
          // the push of this version was still on its way to the main process: ask once more
          if (reloaded) return finish(null)
          reloaded = true
          frame.src = `${url}?probe=${version}-again`
          return
        }
        post({ type: 'gx:setMode', mode: 'browse' })
        post({ type: 'gx:setPaged', paper })
        post({ type: 'gx:measurePages' })
      } else if (msg.type === 'gx:pageReport' && msg.version === version) {
        finish(readPageMeasure(msg))
      }
    }
    const timer = window.setTimeout(() => finish(null), PROBE_TIMEOUT_MS)
    window.addEventListener('message', onMessage)
    frame.src = `${url}?probe=${version}`
    document.body.appendChild(frame)
  })
}
