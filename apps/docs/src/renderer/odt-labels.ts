/**
 * Label boxes for ODT placeholders without a preview picture.
 *
 * The ODT bridge shows an object the editor cannot change (formula, shape,
 * text box …) as a locked picture. When the file stored no preview of the
 * object, that picture is a neutral grey image; the editor draws a box naming
 * the kind instead ("Equation (shown in Hancom)"). The box is an SVG used as the
 * picture's source, so the page, print and PDF export show the same thing.
 * The colors are document content (the box stands in for an object on the
 * page), not UI chrome: they are the same in both themes.
 */
import type { Node as PmNode } from '@tiptap/pm/model'
import type { ObjectKind } from '@genoffice/odt-engine'
import { keepOfNode, labelText } from './odt-gate'

const FILL = '#F2F2F2'
const STROKE = '#8C8C8C'
const INK = '#404040'

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** rough advance of a label in em: CJK / Hangul full width, the rest about half */
function labelEm(text: string): number {
  let em = 0
  for (const ch of text) em += /[ᄀ-ᇿ⺀-鿿가-힯＀-￯]/.test(ch) ? 1 : 0.56
  return Math.max(1, em)
}

/** the label box of `kind` at a picture size (CSS px) */
export function labelSvg(kind: ObjectKind, widthPx: number, heightPx: number): string {
  const w = Math.max(1, Math.round(widthPx || 1))
  const h = Math.max(1, Math.round(heightPx || 1))
  const text = labelText(kind)
  const size = Math.max(4, Math.min(16, h * 0.45, (w * 0.92) / labelEm(text)))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect x="0.5" y="0.5" width="${Math.max(0, w - 1)}" height="${Math.max(0, h - 1)}" ` +
    `fill="${FILL}" stroke="${STROKE}" stroke-width="1" stroke-dasharray="4 2"/>` +
    `<text x="${w / 2}" y="${h / 2}" font-family="sans-serif" font-size="${size.toFixed(1)}" ` +
    `fill="${INK}" text-anchor="middle" dominant-baseline="central">${escapeXml(text)}</text>` +
    `</svg>`
  )
}

export function labelSvgDataUrl(kind: ObjectKind, widthPx: number, heightPx: number): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(labelSvg(kind, widthPx, heightPx))}`
}

/**
 * The picture source a placeholder node shows instead of its neutral picture,
 * or null for every other picture (and outside ODT documents).
 */
export function odtLabelSrc(node: PmNode): string | null {
  const keep = keepOfNode(node)
  if (!keep?.neutral) return null
  const inline = node.type.name === 'docInlineImage'
  const w = Number(inline ? node.attrs.widthPx : node.attrs.imageWidthPx) || 96
  const h = Number(inline ? node.attrs.heightPx : node.attrs.imageHeightPx) || 48
  return labelSvgDataUrl(keep.kind, w, h)
}
