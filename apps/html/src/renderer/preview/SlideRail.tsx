import { useEffect, useRef, useState, type RefObject } from 'react'
import { useI18n } from '../i18n/locale'
import { isFromInspector, type SlideReport, type ToInspector } from './inspector-protocol'

/** CSS px a thumbnail is drawn at (the rail's column) */
const THUMB_WIDTH = 112
/** typing settles this long before the thumbnails load the new copy */
const REDRAW_MS = 800
/** thumbnails this far outside the rail's view still keep (or get) their frame */
const NEAR_MARGIN = '240px 0px'

interface Props {
  /** html-preview:// URL of this view */
  url: string
  /** parse-map version of the copy the main process serves; thumbnails reload when it changes */
  version: number
  deck: SlideReport
  onPick(index: number): void
}

/**
 * The slides of a deck, small. Each thumbnail is the served copy in a frame of
 * its own at the preview's size, told to show its slide and scaled down: the
 * deck's own styles and scripts draw it, so it looks as the slide does. Only
 * thumbnails near the rail's view hold a frame.
 */
export function SlideRail({ url, version, deck, onPick }: Props) {
  const { t } = useI18n()
  const railRef = useRef<HTMLElement>(null)
  const currentRef = useRef<HTMLButtonElement>(null)
  const [shownVersion, setShownVersion] = useState(version)
  useEffect(() => {
    if (version === shownVersion) return
    const timer = window.setTimeout(() => setShownVersion(version), REDRAW_MS)
    return () => window.clearTimeout(timer)
  }, [version, shownVersion])
  const shown = deck.current
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest' })
  }, [shown])
  const scale = THUMB_WIDTH / deck.width
  return (
    <nav className="page-rail slide-rail" aria-label={t('slideThumbs')} ref={railRef}>
      {Array.from({ length: deck.count }, (_, i) => (
        <button
          key={i}
          type="button"
          ref={i === shown ? currentRef : undefined}
          className={`page-thumb${i === shown ? ' current' : ''}`}
          aria-label={t('slideThumbGo', { n: i + 1 })}
          aria-current={i === shown ? 'page' : undefined}
          onClick={() => onPick(i)}
        >
          <span
            className="page-thumb-sheet slide-thumb-sheet"
            style={{ height: Math.round(deck.height * scale) }}
          >
            <SlideThumbFrame
              src={`${url}?slide=${shownVersion}-${i}`}
              slide={i}
              width={deck.width}
              height={deck.height}
              scale={scale}
              rail={railRef}
            />
          </span>
          <span className="page-thumb-no">{i + 1}</span>
        </button>
      ))}
    </nav>
  )
}

function SlideThumbFrame({
  src,
  slide,
  width,
  height,
  scale,
  rail,
}: {
  src: string
  slide: number
  width: number
  height: number
  scale: number
  rail: RefObject<HTMLElement | null>
}) {
  const holderRef = useRef<HTMLSpanElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    const holder = holderRef.current
    if (!holder) return
    const observer = new IntersectionObserver(
      (entries) => setNear(entries.some((entry) => entry.isIntersecting)),
      { root: rail.current, rootMargin: NEAR_MARGIN },
    )
    observer.observe(holder)
    return () => observer.disconnect()
  }, [rail])
  useEffect(() => {
    if (!near) return
    const listener = (event: MessageEvent) => {
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow || !isFromInspector(event.data)) return
      if (event.data.type !== 'gx:ready') return
      const post = (msg: ToInspector) => frame.contentWindow?.postMessage(msg, '*')
      post({ type: 'gx:setMode', mode: 'browse' })
      post({ type: 'gx:thumbnail', slide })
    }
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  }, [near, slide])
  return (
    <span ref={holderRef} className="slide-thumb-holder">
      {near && (
        <iframe
          ref={frameRef}
          className="slide-thumb-frame"
          src={src}
          // the document's scripts run (they draw the deck) but get nothing beyond that
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          aria-hidden="true"
          tabIndex={-1}
          style={{ width, height, transform: `scale(${scale})` }}
        />
      )}
    </span>
  )
}
