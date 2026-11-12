/** PowerPoint show actions: <a:hlinkClick r:id="" action="ppaction://hlinkshowjump?jump=<name>"/>. */
import { call } from './engine'

export const NAMED_ACTIONS = [
  'nextslide',
  'previousslide',
  'firstslide',
  'lastslide',
  'lastslideviewed',
  'endshow',
] as const
export type NamedAction = (typeof NAMED_ACTIONS)[number]
/** The named action of an hlinkClick `action` attribute value, or null for other actions. */
export function namedActionOf(action: string | undefined | null): NamedAction | null {
  return call('namedActionOf', [action]) as never
}
export function namedActionAttr(action: string): string {
  return call('namedActionAttr', [action]) as never
}