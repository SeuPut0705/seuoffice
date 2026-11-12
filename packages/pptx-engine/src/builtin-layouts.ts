/**
 * Built-in standard slide layouts (PowerPoint's core set).
 *
 * AI-generated decks usually ship a single empty layout, leaving the layout
 * picker useless. These definitions mirror the Office default template's
 * placeholder geometry (16:9 base, scaled to the actual slide size) and are
 * injected into the package on first use: layout part + rels + [Content_Types]
 * override + slideMaster registration (rels + sldLayoutIdLst), so the result
 * is a regular layout PowerPoint also understands.
 */
import type { PackageArchive } from './zip'
import type { SlideSize } from './types'
import { type SlideLayoutInfo } from './layout'
import { call } from './engine'

/** Virtual layout-path prefix offered by the UI before the layout exists in the package */
export const BUILTIN_LAYOUT_PREFIX = 'builtin:'
interface BuiltinPh {
  type: string
  idx?: string
  /** Geometry in the Office 16:9 base (12192000×6858000 EMU), scaled to the deck size on use */
  x: number
  y: number
  cx: number
  cy: number
}
export interface BuiltinLayoutDef {
  key: string
  /** Canonical <p:cSld name>: PowerPoint's English layout name (the UI localizes known names) */
  name: string
  /** <p:sldLayout type> */
  type: string
  placeholders: BuiltinPh[]
}
const TITLE: BuiltinPh = { type: 'title', x: 838200, y: 365125, cx: 10515600, cy: 1325563 }
const BODY: BuiltinPh = { type: 'body', idx: '1', x: 838200, y: 1825625, cx: 10515600, cy: 4351338 }
export const BUILTIN_LAYOUTS: BuiltinLayoutDef[] = [
  {
    key: 'titleSlide',
    name: 'Title Slide',
    type: 'title',
    placeholders: [
      { type: 'ctrTitle', x: 1524000, y: 1122363, cx: 9144000, cy: 2387600 },
      { type: 'subTitle', idx: '1', x: 1524000, y: 3602038, cx: 9144000, cy: 1655762 },
    ],
  },
  { key: 'titleContent', name: 'Title and Content', type: 'obj', placeholders: [TITLE, BODY] },
  {
    key: 'sectionHeader',
    name: 'Section Header',
    type: 'secHead',
    placeholders: [
      { type: 'title', x: 831850, y: 4589463, cx: 10515600, cy: 1500187 },
      { type: 'body', idx: '1', x: 831850, y: 1709738, cx: 10515600, cy: 2852737 },
    ],
  },
  {
    key: 'twoContent',
    name: 'Two Content',
    type: 'twoObj',
    placeholders: [
      TITLE,
      { type: 'body', idx: '1', x: 838200, y: 1825625, cx: 5157787, cy: 4351338 },
      { type: 'body', idx: '2', x: 6172200, y: 1825625, cx: 5181600, cy: 4351338 },
    ],
  },
  { key: 'titleOnly', name: 'Title Only', type: 'titleOnly', placeholders: [TITLE] },
  { key: 'blank', name: 'Blank', type: 'blank', placeholders: [] },
]
/**
 * Whether the picker should offer the built-in set: true while no foreign
 * (non-built-in-named) layout carries placeholders. Judging by name keeps
 * already-injected built-ins from turning the offer off — otherwise the rest
 * of the standard set would vanish after the first one is used.
 */
export function shouldOfferBuiltinLayouts(
  layouts: Array<{ name: string; placeholders: unknown[] }>,
): boolean {
  return call('shouldOfferBuiltinLayouts', [layouts], { names: ['layouts'] }) as never
}
/**
 * Virtual SlideLayoutInfo entries for the layout picker (path = 'builtin:<key>').
 * Definitions whose canonical name collides with an existing layout are skipped.
 */
export function builtinLayoutInfos(size: SlideSize, existingNames: Set<string>): SlideLayoutInfo[] {
  return call('builtinLayoutInfos', [size, existingNames]) as never
}
/**
 * Make sure a built-in layout exists in the package and return its path.
 * Idempotent: an existing layout with the same canonical name is reused.
 * Returns null for an unknown key or a package without a slideMaster.
 */
export function ensureBuiltinLayout(
  archive: PackageArchive,
  size: SlideSize,
  key: string,
): string | null {
  return call('ensureBuiltinLayout', [archive, size, key], { mut: { 0: 'archive' } }) as never
}
