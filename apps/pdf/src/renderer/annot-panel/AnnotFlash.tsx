/**
 * The brief flash on the place an annotation panel item points at
 * (reading-assist spec 4.3). Screen-only DOM over the page: never part of a
 * save, the print raster or an export. Colors come from theme tokens.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { pdfRectToCss, type PageGeom } from '../annotations'

export interface AnnotFlashTarget {
  origIdx: number
  /** PDF user space */
  rect: [number, number, number, number]
  /** a new value restarts the animation on the same place */
  seq: number
}

/** how long the flash stays, ms (matches the CSS animation) */
export const ANNOT_FLASH_MS = 1200

/** the flash state of one editor: `flash` starts one, it clears itself */
export function useAnnotFlash(): [
  AnnotFlashTarget | null,
  (origIdx: number, rect: AnnotFlashTarget['rect']) => void,
] {
  const [target, setTarget] = useState<AnnotFlashTarget | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const seq = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const flash = useCallback((origIdx: number, rect: AnnotFlashTarget['rect']) => {
    window.clearTimeout(timer.current)
    seq.current += 1
    setTarget({ origIdx, rect, seq: seq.current })
    timer.current = window.setTimeout(() => setTarget(null), ANNOT_FLASH_MS)
  }, [])
  return [target, flash]
}

/** a few px around the place so a point (a note pin) or a thin line still shows */
const PAD = 4

export function AnnotFlash({
  target,
  geom,
  scale,
}: {
  target: AnnotFlashTarget
  geom: PageGeom
  scale: number
}): ReactElement {
  const box = pdfRectToCss(geom, target.rect, scale)
  return (
    <div
      key={target.seq}
      className="pdf-annot-flash"
      aria-hidden="true"
      style={{
        left: box.left - PAD,
        top: box.top - PAD,
        width: Math.max(box.width, 8) + PAD * 2,
        height: Math.max(box.height, 8) + PAD * 2,
      }}
    />
  )
}
