/**
 * The preview of AI highlight suggestions (reading-assist spec 4.6): a
 * translucent box in the label's color over each pending suggestion that was
 * found in the page's text layer. Screen-only: DOM over the page, never an
 * annotation, never in the save request, the print raster or an export. The
 * box color is the label's (document data a suggestion would become), not a
 * theme color.
 */
import { useSyncExternalStore, type ReactElement } from 'react'
import { pdfRectToCss, type PageGeom } from '../annotations'
import { Icon } from '../icons'
import type { HighlightSuggestions } from './highlight-controller'
import { cssColor } from './presets'

/** how strongly the label color covers the text in the preview */
const PREVIEW_ALPHA = 0.35

export function HighlightPreviewLayer({
  suggestions,
  origIdx,
  geom,
  scale,
}: {
  suggestions: HighlightSuggestions
  /** the original page index this layer sits on */
  origIdx: number
  geom: PageGeom
  scale: number
}): ReactElement | null {
  const snap = useSyncExternalStore(suggestions.subscribe, suggestions.snapshot)
  const here = (snap.views ?? []).filter(
    (v) => v.state === 'pending' && !snap.accepting.has(v.key) && v.found?.origIdx === origIdx,
  )
  if (here.length === 0) return null
  return (
    <div className="pdf-hl-preview-layer" aria-hidden="true">
      {here.flatMap((v) =>
        v.found!.rects.map((r, i) => (
          <div
            key={`${v.key}-${i}`}
            className="pdf-hl-preview"
            data-suggestion={v.key}
            style={{
              ...pdfRectToCss(geom, r, scale),
              background: cssColor(v.label.color, PREVIEW_ALPHA),
            }}
          />
        )),
      )}
    </div>
  )
}

/** the View tab button of the preview: a line of text under a marker stroke */
export const IconHighlightPreview = (): ReactElement => (
  <Icon>
    <path d="M4 15.5h16" strokeWidth="5" strokeOpacity="0.35" />
    <path d="M5 9.5h14M5 15.5h10" />
  </Icon>
)
