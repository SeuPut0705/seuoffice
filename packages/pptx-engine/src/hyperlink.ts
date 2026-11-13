/**
 * Element-level hyperlinks — <a:hlinkClick> under <p:cNvPr>.
 *
 * Two kinds of targets:
 * - External URL: a hyperlink relationship with TargetMode="External" in the slide rels;
 * - In-document slide jump: hlinkClick with action="ppaction://hlinksldjump",
 *   whose relationship (type=slide) points at the target slideN.xml.
 * - Named show action (next/previous/first/last slide, last viewed, end show):
 *   action="ppaction://hlinkshowjump?jump=<name>" with an empty r:id and no relationship.
 *
 * Implemented via "XML surgery + materialize": edit the cNvPr in the element's
 * current fragment, then reparse the whole slide (same path as appendRawElements).
 */
import type { Slide } from './types'
import { type OpenedPptx } from './index'
import { type NamedAction } from './named-action'
import { call } from './engine'

export type LinkTarget =
  | { kind: 'url'; url: string; tooltip?: string }
  | { kind: 'slide'; slideIndex: number; tooltip?: string }
  | { kind: 'action'; action: NamedAction; tooltip?: string }
/**
 * Set/clear an element hyperlink. Relationships no longer used by any live slide
 * XML are pruned after the fragment changes. On success returns the materialized
 * new slide model (all element ids refreshed); on failure returns null.
 */
export function setElementLink(
  opened: OpenedPptx,
  slideIndex: number,
  elementId: string,
  target: LinkTarget | null,
): Slide | null {
  return (call('setElementLink', [opened, slideIndex, elementId, target], {
    mut: { 0: 'opened' },
  }) as never)
    ? opened.deck.slides[slideIndex]!
    : null
}
/** Parse a TextRun.hyperlink encoded target ("slide:N", "action:<name>" or url); null on bad input. */
export function decodeRunLink(s: string): LinkTarget | null {
  return call('decodeRunLink', [s]) as never
}
/** TextRun.hyperlink encoding of a link target. */
export function encodeRunLink(target: LinkTarget): string {
  return call('encodeRunLink', [target]) as never
}
/**
 * Allocate slide-rels relationships for runs whose hyperlink was set this session
 * (hyperlink present, hyperlinkRId absent — the edit path clears the rId on change).
 * The caller reconciles the before/after slide XML after its text patch so cleared
 * or replaced relationship ids can be removed safely. Returns whether anything
 * was allocated.
 */
export function ensureRunLinkRels(
  opened: OpenedPptx,
  slideIndex: number,
  paragraphs: Array<{
    runs: Array<{ hyperlink?: string; hyperlinkRId?: string; hyperlinkAction?: string }>
  }>,
): boolean {
  return call('ensureRunLinkRels', [opened, slideIndex, paragraphs], {
    mut: { 0: 'opened', 2: 'Paragraph[]' },
  }) as never
}
/**
 * All run-level hyperlinks on a slide, resolved live against the rels (parse-time
 * TextRun.hyperlink can go stale after slide reorders). Keyed by element + paragraph +
 * run indexes; the slideshow matches these against layout glyph runs to hit-test clicks.
 */
export function getRunLinks(
  opened: OpenedPptx,
  slideIndex: number,
): Array<{ elementId: string; paraIndex: number; runIndex: number; target: LinkTarget }> {
  return call('getRunLinks', [opened, slideIndex], { opened: [0] }) as never
}
/** Read an element's current hyperlink (for UI echo-back); returns null if none. */
export function getElementLink(
  opened: OpenedPptx,
  slideIndex: number,
  elementId: string,
): LinkTarget | null {
  return call('getElementLink', [opened, slideIndex, elementId], { opened: [0] }) as never
}
/**
 * All element hyperlinks on a slide (groups scanned recursively) — the slideshow
 * uses this to hit-test clicks and follow slide jumps (Zoom) / external URLs.
 * Group children have empty anchors (their bytes live only inside the group's
 * fragment), so each child's XML is sliced out of the group XML by index.
 */
export function getSlideLinks(
  opened: OpenedPptx,
  slideIndex: number,
): Array<{ elementId: string; target: LinkTarget }> {
  return call('getSlideLinks', [opened, slideIndex], { opened: [0] }) as never
}
