/** messages between the app (parent) and the inspector script inside the sandboxed preview frame */

/** inspect = full editing; browse = the page behaves as published */
export type InspectorMode = 'inspect' | 'browse'

export type ToInspector =
  | { type: 'gx:select'; sid: number | null }
  /** the rest of a multiple selection, after gx:select named its first element (a reload forgets it) */
  | { type: 'gx:selectExtra'; sids: number[] }
  | { type: 'gx:highlight'; sids: number[] }
  | { type: 'gx:clearHighlight' }
  | { type: 'gx:setMode'; mode: InspectorMode }
  | { type: 'gx:beginTextEdit'; sid: number }
  | { type: 'gx:theme'; dark: boolean }
  /** poke inline styles for a live preview; the host commits them to the source as one set_style op */
  | { type: 'gx:previewStyle'; sid: number; styles: Record<string, string | null> }
  /** the mouse button went up over the host chrome: a reorder drag in the frame ends without a drop */
  | { type: 'gx:endDrag' }
  /** numbered pins on elements with queued AI edits (replaces the previous set) */
  | { type: 'gx:mark'; marks: Array<{ sid: number; label: string }> }
  /** restore the window scroll of the copy an edit just replaced */
  | { type: 'gx:scrollTo'; y: number }
  /** lay the page out on the paper it prints on, or (null) back as one continuous page */
  | { type: 'gx:setPaged'; paper: PaperLayout | null }
  /** measure the paper view once fonts and pictures have settled; answered with gx:pageReport */
  | { type: 'gx:measurePages' }
  /** show this slide of the deck the frame found (0-based, in the order gx:slides counts them) */
  | { type: 'gx:goToSlide'; index: number }
  /** the frame is a slide thumbnail: no scrollbars, and this slide once the page has loaded */
  | { type: 'gx:thumbnail'; slide: number }

/** the printed page as the frame draws it: the frame itself is the content box, sheets stack downwards */
export interface PaperLayout {
  /** page content box, frame px */
  width: number
  height: number
  marginTop: number
  marginBottom: number
  /** desk showing between two sheets */
  gap: number
  /** chrome colours resolved from the host's tokens (the frame cannot read them) */
  desk: string
  ink: string
}

/** effective styles of the selected element (px numbers without unit, colours as #rrggbb, '' when transparent) */
export interface ComputedSnapshot {
  color: string
  fontSize: string
  fontWeight: string
  fontStyle: string
  textAlign: string
  background: string
  /** computed `background-image` ('none', gradients, url(...) layers) */
  backgroundImage: string
  width: string
  height: string
  borderRadius: string
  padding: string
  opacity: string
  /** authored inline values (what set_style writes back), not the resolved matrix / px */
  transform: string
  marginLeft: string
  marginRight: string
  objectFit: string
  /** only on <img> */
  image?: { src: string; alt: string; naturalWidth: number; naturalHeight: number }
}

export interface ElementRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ElementFingerprint {
  sid: number
  tag: string
  className: string
  /** direct child element count and text content, compared against the source to spot script-mutated nodes */
  childElementCount: number
  text: string
  rect: ElementRect
  computed: ComputedSnapshot
  /** the element's single direct text run, when it has exactly one (inline-editable) */
  textRun: string | null
  /** index of that run among the element's direct text nodes (set_text_node's index), -1 without a run */
  textRunIndex: number
  /** the element's text edits in place (single run, or text mixed with phrasing children) */
  inlineEditable: boolean
}

/** every message carries the parse-map version the frame was instrumented with */
export type FromInspector = { version: number } & FromInspectorBody

export type FromInspectorBody =
  | { type: 'gx:editMath'; sid: number }
  | { type: 'gx:ready'; title: string; docHeight: number }
  /** the window scrolled (coalesced per frame); the host hands it back after a reload */
  | { type: 'gx:scroll'; y: number }
  | { type: 'gx:hover'; sid: number | null }
  | {
      type: 'gx:rect'
      sid: number
      rect: ElementRect
      computed: ComputedSnapshot
      textRun: string | null
      textRunIndex: number
      inlineEditable: boolean
    }
  | { type: 'gx:select'; element: ElementFingerprint | null; dynamic: boolean }
  /** shift / ctrl+click changed what is selected alongside the gx:select element; read with readExtraSids */
  | { type: 'gx:multiSelect'; sids: unknown }
  | {
      type: 'gx:textSelect'
      sid: number
      /** index among the element's direct child text nodes */
      textNodeIndex: number
      start: number
      end: number
      text: string
    }
  | { type: 'gx:textEditCommit'; sid: number; textNodeIndex: number; newText: string }
  /** rich inline edit (text mixed with <strong> / <a> / <br> children): the whole inner HTML, data-gx-sid stripped */
  | { type: 'gx:htmlEditCommit'; sid: number; html: string }
  | { type: 'gx:textEditCancel' }
  | {
      type: 'gx:keyCommand'
      command:
        | 'delete'
        | 'parent'
        | 'next'
        | 'prev'
        | 'child'
        | 'askAi'
        | 'bold'
        | 'italic'
        | 'escape'
        | 'undo'
        | 'redo'
        | 'zoomIn'
        | 'zoomOut'
        | 'zoomReset'
        | 'moveUp'
        | 'moveDown'
    }
  /** ctrl/meta + wheel inside the frame (trackpad pinch); the host owns the zoom level */
  | { type: 'gx:zoom'; delta: number }
  | { type: 'gx:navigateBlocked'; href: string }
  | { type: 'gx:markClick'; sid: number }
  /** a resize handle or a sideways image slide was released: the frame already shows these inline styles */
  | { type: 'gx:resize'; sid: number; styles: Record<string, string> }
  /** the selected element was dropped next to another one */
  | { type: 'gx:moveTo'; sid: number; position: 'before' | 'after'; ref_sid: number }
  /** a resize or reorder drag started / ended (the host hides its chrome meanwhile) */
  | { type: 'gx:drag'; active: boolean }
  /** the paper view was laid out or re-flowed: sheet count and the page colour its margins continue in */
  | { type: 'gx:paged'; pages: number; sheet: string }
  /** answer to gx:measurePages; its fields are read with readPageMeasure, never taken as typed */
  | { type: 'gx:pageReport' }
  /** the slides the page shows one at a time (or a screen each) and the one in view; read with readSlideReport */
  | { type: 'gx:slides' }

/** Message tags the instrumented inspector can emit; anything else is forged. */
const KNOWN_FROM_INSPECTOR = new Set([
  'gx:editMath',
  'gx:ready',
  'gx:scroll',
  'gx:hover',
  'gx:rect',
  'gx:select',
  'gx:multiSelect',
  'gx:textSelect',
  'gx:textEditCommit',
  'gx:htmlEditCommit',
  'gx:textEditCancel',
  'gx:keyCommand',
  'gx:zoom',
  'gx:navigateBlocked',
  'gx:markClick',
  'gx:resize',
  'gx:moveTo',
  'gx:drag',
  'gx:paged',
  'gx:pageReport',
  'gx:slides',
])

export function isFromInspector(data: unknown): data is FromInspector {
  // The frame has an opaque origin (no allow-same-origin), so event.origin is
  // useless and any script in the previewed document can postMessage here:
  // require a known tag plus the numeric instrumentation version (the App
  // additionally drops versions outside its live parse-map set).
  if (typeof data !== 'object' || data === null) return false
  const { type, version } = data as { type?: unknown; version?: unknown }
  return (
    typeof type === 'string' &&
    KNOWN_FROM_INSPECTOR.has(type) &&
    typeof version === 'number' &&
    Number.isFinite(version)
  )
}

/** more than this many elements at once is not a selection anyone made by clicking */
const MAX_EXTRA_SIDS = 200

/** The sids of a gx:multiSelect, in click order and without repeats; anything else in the list is dropped. */
export function readExtraSids(sids: unknown): number[] {
  if (!Array.isArray(sids)) return []
  const seen = new Set<number>()
  for (const sid of sids) {
    if (typeof sid === 'number' && Number.isInteger(sid) && sid >= 0) seen.add(sid)
    if (seen.size >= MAX_EXTRA_SIDS) break
  }
  return [...seen]
}

/** what the host draws around the frame in the paper view */
export interface PaperReport {
  pages: number
  sheet: string
}

/** The frame is untrusted and `sheet` ends up in a style value: only a plain colour passes. */
export function readPaperReport(msg: { pages: unknown; sheet: unknown }): PaperReport | null {
  const { pages, sheet } = msg
  if (typeof pages !== 'number' || !Number.isInteger(pages) || pages < 1 || pages > 100_000)
    return null
  if (typeof sheet !== 'string' || !/^(#[0-9a-f]{3,8}|rgba?\([\d\s.,/%]+\))$/i.test(sheet))
    return null
  return { pages, sheet }
}

/** the deck the frame found: how many slides, the one in view, and the frame's viewport they are drawn in */
export interface SlideReport {
  count: number
  current: number
  width: number
  height: number
}

/** a deck longer than this is not one anyone pages through by hand */
const MAX_SLIDES = 500

/** The frame is untrusted: counts and sizes pass only as small whole numbers. */
export function readSlideReport(msg: object): SlideReport | null {
  const { count, current, width, height } = msg as Record<string, unknown>
  const whole = (v: unknown, max: number): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max
  if (!whole(count, MAX_SLIDES) || !whole(current, MAX_SLIDES)) return null
  if (!whole(width, 20_000) || !whole(height, 20_000) || width === 0 || height === 0) return null
  return { count, current: Math.min(current, Math.max(count - 1, 0)), width, height }
}
