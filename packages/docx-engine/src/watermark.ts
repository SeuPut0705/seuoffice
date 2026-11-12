import type { HfImage, PictureWatermarkInfo } from './types'
import { invoke } from './engine'

/** read the watermark text from a header part; null when it has none */
export function readWatermarkText(headerXml: string): string | null {
  return invoke('readWatermarkText', [headerXml]) as never
}
/**
 * Display geometry of a WordArt watermark pict: box size, rotation, anchor,
 * fill color/opacity and the textpath font. Word stretches the glyph ink to
 * the box (fitshape), so the declared font-size is irrelevant here.
 */
export function readWatermarkShape(pictXml: string): HfImage | null {
  return invoke('readWatermarkShape', [pictXml]) as never
}
/** Text watermark as written by set_watermark / the Design tab; a bare string is the text alone. */
export interface WatermarkSpec {
  text: string
  fontFamily?: string
  /** hex without '#' (default silver) */
  colorHex?: string
  /** 0..1 fill opacity (default 0.5) */
  opacity?: number
  /** rotated 315 degrees like Word's diagonal layout (default true) */
  diagonal?: boolean
  bold?: boolean
  italic?: boolean
  /** shape box for an explicit font size (Word's Size != Auto); absent = Word's auto box */
  boxPt?: { widthPt: number; heightPt: number }
  /** the Size `boxPt` was measured at, so the dialog reopens on it (not written to the file) */
  sizePt?: number
}
/** Picture watermark as written by set_watermark / Word's Design tab. */
export interface PictureWatermarkSpec {
  image: {
    /** raw image bytes, base64 encoded */
    base64: string
    mime: 'image/png' | 'image/jpeg' | 'image/gif'
    widthPx: number
    heightPx: number
  }
  /** percent of the image's natural size; absent = fit inside the page margin box */
  scale?: number
  /** Word's washout (faded) look (default true) */
  washout?: boolean
}
export type Watermark = string | WatermarkSpec | PictureWatermarkSpec
export function isPictureWatermark(wm: Watermark): wm is PictureWatermarkSpec {
  return invoke('isPictureWatermark', [wm]) as never
}
export type { PictureWatermarkInfo }
/**
 * The header image a pending (unsaved) picture watermark will parse back as,
 * so the page preview can draw it exactly where the save path will put it.
 */
export function pictureWatermarkPreviewImage(
  spec: PictureWatermarkSpec,
  marginBox: { widthPt: number; heightPt: number } | null,
): HfImage {
  return invoke('pictureWatermarkPreviewImage', [spec, marginBox]) as never
}
/** Box of the text watermark shape in points (explicit size, or Word's auto box per layout). */
export function textWatermarkBoxPt(spec: WatermarkSpec): { widthPt: number; heightPt: number } {
  return invoke('textWatermarkBoxPt', [spec]) as never
}
/** The header image a pending text watermark parses back as (see readWatermarkShape). */
export function textWatermarkPreviewImage(spec: WatermarkSpec): HfImage {
  return invoke('textWatermarkPreviewImage', [spec]) as never
}
/**
 * the picture watermark of a header part; null when it has none.
 *
 * r:id is read quote-agnostically: a header that spells the attribute with
 * single quotes still has to yield its relationship id, or the save cannot
 * reclaim the relationship the old watermark owned and leaves it orphaned
 * behind the replacement.
 */
export function readPictureWatermark(headerXml: string): PictureWatermarkInfo | null {
  return invoke('readPictureWatermark', [headerXml]) as never
}
