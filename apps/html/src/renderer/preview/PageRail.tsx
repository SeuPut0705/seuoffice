import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n/locale'
import { drawPageThumbs, type PageThumb } from './print-thumbs'

/** CSS px a thumbnail is drawn at (the rail's column) */
const THUMB_WIDTH = 112
/** typing settles this long before the print PDF is asked for again */
const REDRAW_MS = 700

/**
 * The printed pages of the document, small: drawn from the PDF the export
 * writes, so the page-number footers and every break are the print engine's
 * own. Until a page is redrawn after an edit its previous bitmap stays.
 */
export function usePageThumbs(html: string | null): { thumbs: Array<PageThumb | null> } {
  const [thumbs, setThumbs] = useState<Array<PageThumb | null>>([])
  const liveRef = useRef<Array<PageThumb | null>>([])
  useEffect(() => {
    if (html === null) return
    let stale = false
    const timer = window.setTimeout(
      async () => {
        try {
          const pdf = await window.htmlApi.renderPrintPreview({ html })
          if (stale || !pdf) return
          const pages = await drawPageThumbs(
            pdf,
            THUMB_WIDTH,
            (index, thumb) => {
              const next = liveRef.current.slice()
              if (next[index]) URL.revokeObjectURL(next[index].url)
              next[index] = thumb
              liveRef.current = next
              setThumbs(next)
            },
            () => stale,
          )
          if (stale) return
          // pages the document no longer has, and slots for those past the drawing limit
          const next = Array.from({ length: pages }, (_, i) => liveRef.current[i] ?? null)
          for (const dropped of liveRef.current.slice(pages))
            if (dropped) URL.revokeObjectURL(dropped.url)
          liveRef.current = next
          setThumbs(next)
        } catch (err) {
          console.error('[html] page thumbnails failed:', err)
        }
      },
      // the first drawing has nothing to wait for; later ones let the typing settle
      liveRef.current.length ? REDRAW_MS : 0,
    )
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [html])
  useEffect(() => {
    if (html !== null) return
    for (const thumb of liveRef.current) if (thumb) URL.revokeObjectURL(thumb.url)
    liveRef.current = []
    setThumbs([])
  }, [html])
  useEffect(
    () => () => {
      for (const thumb of liveRef.current) if (thumb) URL.revokeObjectURL(thumb.url)
    },
    [],
  )
  return { thumbs }
}

interface Props {
  thumbs: Array<PageThumb | null>
  /** sheets of the paper view; the rail has a slot for each before its bitmap exists */
  pages: number
  /** page at the reader's eye in the preview, 0-based */
  current: number
  /** sheet height over width, for slots without a bitmap yet */
  ratio: number
  onPick(page: number): void
}

export function PageRail({ thumbs, pages, current, ratio, onPick }: Props) {
  const { t } = useI18n()
  const currentRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest' })
  }, [current])
  const count = Math.max(pages, thumbs.length)
  return (
    <nav className="page-rail" aria-label={t('pageThumbs')}>
      {Array.from({ length: count }, (_, i) => {
        const thumb = thumbs[i]
        return (
          <button
            key={i}
            type="button"
            ref={i === current ? currentRef : undefined}
            className={`page-thumb${i === current ? ' current' : ''}`}
            aria-label={t('pageThumbGo', { n: i + 1 })}
            aria-current={i === current ? 'page' : undefined}
            onClick={() => onPick(i)}
          >
            <span
              className="page-thumb-sheet"
              style={{ aspectRatio: String(1 / (thumb?.ratio ?? ratio)) }}
            >
              {thumb && <img src={thumb.url} alt="" draggable={false} />}
            </span>
            <span className="page-thumb-no">{i + 1}</span>
          </button>
        )
      })}
    </nav>
  )
}
