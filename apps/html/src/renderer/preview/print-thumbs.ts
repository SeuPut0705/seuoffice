import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

/** one printed page, drawn small */
export interface PageThumb {
  /** object URL of the bitmap; the caller revokes it */
  url: string
  /** page height over width: the slot keeps its shape while a newer bitmap is on its way */
  ratio: number
}

/** a long report still gets a rail; past this the pages are numbered but not drawn */
const MAX_THUMBS = 300

/**
 * Draw every page of the print PDF at `width` CSS px, first page first, and hand
 * each one over as soon as it exists. Resolves with the page count; `isStale`
 * turning true stops the work (the text has moved on and a newer PDF is coming).
 * pdf.js is loaded on first use: only the paper view pays for it.
 */
export async function drawPageThumbs(
  pdf: Uint8Array,
  width: number,
  onPage: (index: number, thumb: PageThumb) => void,
  isStale: () => boolean,
): Promise<number> {
  const { GlobalWorkerOptions, getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  GlobalWorkerOptions.workerSrc = workerUrl
  const doc = await getDocument({ data: pdf }).promise
  try {
    const canvas = document.createElement('canvas')
    const scale = Math.min(2, window.devicePixelRatio || 1)
    for (let i = 0; i < Math.min(doc.numPages, MAX_THUMBS); i++) {
      if (isStale()) break
      const page = await doc.getPage(i + 1)
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: (width * scale) / base.width })
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      await page.render({ canvas, viewport }).promise
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob || isStale()) break
      onPage(i, { url: URL.createObjectURL(blob), ratio: base.height / base.width })
    }
    canvas.width = 0
    canvas.height = 0
    return doc.numPages
  } finally {
    void doc.loadingTask.destroy()
  }
}
