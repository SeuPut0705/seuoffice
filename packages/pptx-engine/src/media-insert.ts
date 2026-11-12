/**
 * Audio/video / 3D model insertion — media part surgery.
 *
 * Video/audio: the modern PowerPoint dual-relationship form —
 *   <a:videoFile r:link> (2007 semantics) + p14:media r:embed (2010 semantics),
 *   both relationships pointing at the same embedded ppt/media/mediaN.ext part;
 *   blipFill is the poster frame.
 *
 * 3D models: am3d:model3d with a picture fallback, as PowerPoint writes them (model3d.ts).
 * Decks from before carry a plain picture whose cNvPr descr names the model part
 * (`aislides-3d:{partPath}`, model3dPartOf).
 */
import { type Model3dRotation } from './model3d'
import type { EmuRect, Slide } from './types'
import { type OpenedPptx } from './index'
import { call, slideIndex } from './engine'

/** Generate a w×h solid-color PNG (RGB, no alpha). Used as a poster frame placeholder. */
export function solidPng(w: number, h: number, rgb: [number, number, number]): Buffer {
  return call('solidPng', [w, h, rgb]) as never
}
// ── Audio/video ────────────────────────────────────────────────────────

export interface NewMediaOptions {
  kind: 'video' | 'audio'
  bytes: Uint8Array
  /** Lowercase extension (mp4/mov/webm/mp3/wav/m4a…) */
  ext: string
  /** Poster frame (defaults to a generated solid-color placeholder PNG) */
  poster?: { bytes: Uint8Array; ext: string }
  offset: EmuRect
  /** cNvPr name (defaults to a filename-style name) */
  name?: string
}
/** Insert audio/video: media/poster parts + dual relationships + <p:pic> fragment, append + reparse. */
export function addMedia(
  opened: OpenedPptx,
  slideIndex: number,
  opts: NewMediaOptions,
): { slide: Slide; elementId: string } | null {
  const v = call('addMedia', [opened, slideIndex, opts], { mut: { 0: 'opened' } }) as never
  return v === null ? null : { slide: opened.deck.slides[slideIndex]!, elementId: v }
}
// ── 3D models ──────────────────────────────────────────────────────────

export interface NewModel3dOptions {
  /** glTF binary */
  bytes: Uint8Array
  ext: string
  /** The model's rendering: the Fallback picture and am3d:raster (a placeholder when omitted) */
  poster?: { bytes: Uint8Array; ext: string }
  offset: EmuRect
  name?: string
  rot?: Model3dRotation
}
/** Insert a 3D model as PowerPoint stores it (model3d.ts). Only .glb is embedded, as PowerPoint does. */
export function addModel3d(
  opened: OpenedPptx,
  slideIndex: number,
  opts: NewModel3dOptions,
): { slide: Slide; elementId: string } | null {
  const v = call('addModel3d', [opened, slideIndex, opts], { mut: { 0: 'opened' } }) as never
  return v === null ? null : { slide: opened.deck.slides[slideIndex]!, elementId: v }
}
/**
 * Turns a 3D model to `rot` and, with `poster`, replaces its rendering (the Fallback picture
 * and am3d:raster): the editor renders the model, the engine only stores what it drew.
 */
export function setModel3dView(
  opened: OpenedPptx,
  slide: Slide,
  elementId: string,
  view: { rot: Model3dRotation; poster?: { bytes: Uint8Array; ext: string } },
): boolean {
  return call('setModel3dView', [opened, slideIndex(opened, slide), elementId, view], {
    mut: { 0: 'opened' },
  }) as never
}
/** The model part of a picture placeholder written before models were stored as am3d. */
export function model3dPartOf(el: { descr?: string }): string | null {
  return call('model3dPartOf', [el.descr]) as never
}
