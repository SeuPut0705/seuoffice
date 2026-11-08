/**
 * The 2-second highlight of a cited passage (reading-assist spec 4.7): drawn
 * over the page like the search hits, never part of the document (nothing is
 * saved, printed or exported), and cleared by itself.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { pdfRectToCss, type PageGeom } from '../annotations'
import type { SearchIndex } from '../search'
import type { PdfNavTarget } from './pdf-nav'
import { findQuoteRects } from './quote-find'

export const QUOTE_FLASH_MS = 2000
/** how long "location not found" stays: a brief word, not the usual notice */
export const QUOTE_NOT_FOUND_NOTICE_MS = 2500

type Rect = [number, number, number, number]

export interface QuoteFlash {
  /** bumps on every flash, so the same passage cited twice restarts the animation */
  id: number
  /** original page index (0-based) */
  origIdx: number
  rects: Rect[]
}

/** the flash on screen and the call that starts one */
export function useQuoteFlash(): {
  flash: QuoteFlash | null
  show: (origIdx: number, rects: Rect[]) => void
} {
  const [flash, setFlash] = useState<QuoteFlash | null>(null)
  const seq = useRef(0)
  const timer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )
  const show = useCallback((origIdx: number, rects: Rect[]) => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    const id = ++seq.current
    setFlash({ id, origIdx, rects })
    timer.current = window.setTimeout(() => {
      timer.current = null
      setFlash((f) => (f?.id === id ? null : f))
    }, QUOTE_FLASH_MS)
  }, [])
  return { flash, show }
}

/**
 * Where a citation's quote is: its page's rectangles in the viewer's text
 * index, or null when the link has no quote, the page is unknown or the words
 * are not on it (the caller then stays on the page and says so).
 */
export async function locateCitation(
  target: PdfNavTarget,
  index: Promise<SearchIndex> | null,
): Promise<{ origIdx: number; rects: Rect[] } | null> {
  if (!target.quote || !index) return null
  const origIdx = target.page - 1
  const entries = await index.catch(() => null)
  const rects = findQuoteRects(entries?.[origIdx], target.quote)
  return rects ? { origIdx, rects } : null
}

/** the flash boxes of one page */
export function QuoteFlashLayer({
  flash,
  origIdx,
  geom,
  scale,
}: {
  flash: QuoteFlash | null
  origIdx: number
  geom: PageGeom
  scale: number
}): ReactElement | null {
  if (!flash || flash.origIdx !== origIdx) return null
  return (
    <div className="pdf-quote-flash-layer" key={flash.id} aria-hidden="true">
      {flash.rects.map((r, i) => (
        <div key={i} className="pdf-quote-flash" style={pdfRectToCss(geom, r, scale)} />
      ))}
    </div>
  )
}
