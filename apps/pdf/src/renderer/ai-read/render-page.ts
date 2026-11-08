/**
 * Page images for AI page reading (spec §7): one PNG per page at about
 * 150–200 dpi. The job renders from its own PDF.js copy of the file as it was
 * when the job started (the editor opens it with its own PDF.js build), so a
 * save in the meantime, which reloads the viewer's document, does not change
 * what the job reads. The renderer owns that copy and destroys it on close.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist'

/** dots per inch of a page image (spec §7: 150–200, tunable) */
export const AI_READ_DPI = 170
/** longest side of a page image, so a poster-sized page stays a sensible upload */
export const AI_READ_MAX_SIDE_PX = 3200

export interface PageRenderer {
  /** PNG bytes of a 1-based page */
  render(page: number, signal: AbortSignal): Promise<Uint8Array>
  close(): void
}

function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('the page image could not be encoded'))
        return
      }
      blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject)
    }, 'image/png')
  })
}

/** scale for a page of this size in points, at `dpi` but never past the size cap */
export function pageImageScale(widthPt: number, heightPt: number, dpi = AI_READ_DPI): number {
  const scale = dpi / 72
  const longest = Math.max(widthPt, heightPt, 1) * scale
  return longest > AI_READ_MAX_SIDE_PX ? (AI_READ_MAX_SIDE_PX / longest) * scale : scale
}

export function createPageRenderer(doc: PDFDocumentProxy, dpi = AI_READ_DPI): PageRenderer {
  return {
    async render(page, signal) {
      signal.throwIfAborted()
      const p = await doc.getPage(page)
      const base = p.getViewport({ scale: 1 })
      const viewport = p.getViewport({ scale: pageImageScale(base.width, base.height, dpi) })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.floor(viewport.width))
      canvas.height = Math.max(1, Math.floor(viewport.height))
      const task = p.render({ canvas, viewport })
      const onAbort = () => task.cancel()
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        await task.promise
      } finally {
        signal.removeEventListener('abort', onAbort)
        p.cleanup()
      }
      signal.throwIfAborted()
      const png = await canvasPng(canvas)
      canvas.width = 0
      canvas.height = 0
      return png
    },
    close() {
      // pdfjs-dist 6 destroys a document through its loading task
      void doc.loadingTask.destroy()
    },
  }
}
