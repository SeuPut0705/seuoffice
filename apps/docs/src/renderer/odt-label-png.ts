/**
 * Raster form of an ODT placeholder label (see odt-labels.ts): the same SVG the
 * page shows, drawn on a canvas at twice the display size. Used where a picture
 * file is needed (ODT → docx Save As). Its own module so tests can stand in for
 * the canvas, which jsdom does not implement.
 */
import type { ObjectKind } from '@genoffice/odt-engine'
import { labelSvgDataUrl } from './odt-labels'

const SCALE = 2

export async function renderLabelPng(
  kind: ObjectKind,
  widthPx: number,
  heightPx: number,
): Promise<Uint8Array> {
  const img = new Image()
  img.src = labelSvgDataUrl(kind, widthPx, heightPx)
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(widthPx * SCALE))
  canvas.height = Math.max(1, Math.round(heightPx * SCALE))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unavailable')
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('label picture could not be encoded')
  return new Uint8Array(await blob.arrayBuffer())
}
