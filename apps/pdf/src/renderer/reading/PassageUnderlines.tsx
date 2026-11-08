/**
 * The faint dotted line under passages that have a card (reading-assist spec
 * 4.2). Screen-only: it is DOM over the page, never part of the save request,
 * the print raster or an export. A card whose page fingerprint is not on this
 * page (the page changed or was removed) draws nothing. Clicking the line
 * reopens the card. Colors come from theme tokens (styles.css).
 */
import { useSyncExternalStore, type ReactElement } from 'react'
import { pdfRectToCss, quadToRect, type PageGeom } from '../annotations'
import type { AskAnchorRect } from '../AiAskPopover'
import { Icon } from '../icons'
import type { PassageCards } from './passage-controller'

/** height of the clickable band along the bottom of each line, px */
const BAND = 5

export function PassageUnderlines({
  cards,
  origIdx,
  geom,
  scale,
  label,
  onOpen,
}: {
  cards: PassageCards
  /** the original page index this layer sits on */
  origIdx: number
  geom: PageGeom
  scale: number
  /** accessible name of a mark, given the passage */
  label: (excerpt: string) => string
  onOpen: (id: string, anchor: AskAnchorRect) => void
}): ReactElement | null {
  const snap = useSyncExternalStore(cards.subscribe, cards.snapshot)
  const here = snap.cards.filter((c) => cards.pageOf(c) === origIdx)
  if (here.length === 0) return null
  return (
    <div className="pdf-passage-marks">
      {here.flatMap((card) => {
        const short = card.excerpt.replace(/\s+/g, ' ').trim().slice(0, 60)
        return card.quads.map((q, i) => {
          const box = pdfRectToCss(geom, quadToRect(q), scale)
          return (
            <button
              key={`${card.id}-${i}`}
              type="button"
              tabIndex={i === 0 ? 0 : -1}
              className="pdf-passage-mark"
              data-card={card.id}
              aria-label={label(short)}
              style={{
                left: box.left,
                top: box.top + box.height - BAND / 2,
                width: box.width,
                height: BAND,
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                const r = e.currentTarget.getBoundingClientRect()
                onOpen(card.id, { left: r.left, top: r.top, right: r.right, bottom: r.bottom })
              }}
            />
          )
        })
      })}
    </div>
  )
}

/** the View tab button of the marks: lines of text, the last one dotted */
export const IconPassageMarks = (): ReactElement => (
  <Icon>
    <path d="M5 6.5h14M5 11.5h10" />
    <path d="M5 17h14" strokeDasharray="1 3" />
  </Icon>
)
