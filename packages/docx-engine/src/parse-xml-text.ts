// Text and unit primitives shared by every parse-* module: entity decoding,
// plain-text extraction, on/off and measurement attribute readers.
import { invoke } from './engine'

export interface RelInfo {
  target: string
  type: string
  targetMode?: string
}
/**
 * onOffOf for a caller that only has the raw XML of a run's rPr rather than a
 * parsed tree. Reads the toggle off the element's start tag, so both the
 * self-closing and the paired spelling are seen, and an explicit off value is
 * honoured whichever quote style wrote it. Callers that used to sniff this
 * with their own regex silently read a paired element as "not set" and a
 * single-quoted w:val="0" as set.
 */
export function onOffTagIn(xml: string, name: string): boolean | undefined {
  return invoke('onOffTagIn', [xml, name], { undef: true }) as never
}
/** Full decode, for raw XML slices that never passed through the parser. */
export function decodeEntities(text: string): string {
  return invoke('decodeEntities', [text]) as never
}
