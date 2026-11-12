/**
 * Recorded narration (Slide Show > Record), stored the way PowerPoint stores it so PowerPoint
 * plays it back too: per slide, an audio picture in the bottom-right corner that starts with the
 * slide, under a `<p:audio isNarration="1">` media node whose `showWhenStopped="0"` hides it
 * during the show, and presProps' `<p:showPr showNarration="1">` for the whole deck.
 */
import type { OpenedPptx } from './index'
import type { Slide } from './types'
import { call } from './engine'

export const NARRATION_NAME = 'Narration'
export function narrationSpids(slide: Slide): number[] {
  return call('narrationSpids', [slide]) as never
}
/** Removes the slide's narration: its pictures, their timing and their media parts. */
export function clearNarration(opened: OpenedPptx, slideIndex: number): number {
  return call('clearNarration', [opened, slideIndex], { mut: { 0: 'opened' } }) as never
}
export interface NarrationAudio {
  bytes: Uint8Array
  /** wav, m4a or mp3 */
  ext: string
  durationMs: number
}
/**
 * Replaces the slide's narration with `audio`, which plays from the slide's start, before the
 * slide's own animations. The slide's advance time is not touched: see setSlideAdvanceTime.
 */
export function addNarration(
  opened: OpenedPptx,
  slideIndex: number,
  audio: NarrationAudio,
): { slide: Slide; elementId: string } | null {
  const v = call('addNarration', [opened, slideIndex, audio], { mut: { 0: 'opened' } }) as never; return v === null ? null : { slide: opened.deck.slides[slideIndex]!, elementId: v }
}
/**
 * Sets presProps' `showNarration` (its schema default is off, so PowerPoint would not play the
 * recorded narration) and `useTimings`, keeping every other show property.
 */
export function setShowNarration(opened: OpenedPptx): void {
  return call('setShowNarration', [opened], { mut: { 0: 'opened' }, undef: true }) as never
}