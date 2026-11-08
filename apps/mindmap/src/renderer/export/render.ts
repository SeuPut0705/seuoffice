/**
 * A still copy of a sheet (`snapshot.ts`) written out: as a picture, and as a
 * page for PDF and print.
 *
 * Both carry the map's own stylesheets and nothing of the app's: the drawing
 * library's rules and `map.css`, which hold shapes and sizes, and the colours
 * the copy carries as `--mm-` properties of the theme. No chrome token is
 * defined there, and the app's light or dark setting is not part of it, so the
 * output is the same whichever the app shows.
 *
 * The picture is the copy inside an SVG `foreignObject`, drawn by the browser
 * into a canvas. The page is one HTML document: one landscape A4 page in the
 * map's ground colour with the map fitted onto it, a content policy that lets
 * it load nothing but its own `data:` pictures, and no script.
 */
import mapCss from '../map.css?inline'
import { pictureAtSize } from './resample'
import { EXPORT_CLASS, type MapSnapshot } from './snapshot'

/** How the copy sits in a picture or a page: at its own size, from its own top left corner. */
const FRAME_CSS = `
.${EXPORT_CLASS} { position: relative; overflow: hidden; direction: ltr; margin: 0; padding: 0; }
.${EXPORT_CLASS} .map-container { position: absolute; inset: 0; width: 100%; height: 100%; }
.${EXPORT_CLASS} .map-canvas { position: absolute; transform: none; }
`

/**
 * The drawing library's rules, as the page has them: every rule whose
 * selector starts at `.map-container`. The library's stylesheet is the only
 * one written that way (this editor's rules all start at `.mm-card`), and it
 * names only its own properties, which the copy carries from the theme.
 */
function libraryRules(doc: Document): string {
  const rules: string[] = []
  for (const sheet of [...doc.styleSheets]) {
    let list: CSSRuleList
    try {
      list = sheet.cssRules
    } catch {
      continue
    }
    for (const rule of [...list]) {
      if (rule instanceof CSSStyleRule && rule.selectorText.startsWith('.map-container')) {
        rules.push(rule.cssText)
      }
    }
  }
  return rules.join('\n')
}

/** The map's stylesheets, as one text: the library's rules, `map.css`, and how the copy sits. */
export function exportStyles(doc: Document = document): string {
  return [libraryRules(doc), String(mapCss ?? ''), FRAME_CSS].join('\n')
}

// ---- the picture ----

/** The longest side and the most pixels a picture is drawn with; a canvas refuses more. */
const MAX_SIDE = 16_384
const MAX_PIXELS = 48_000_000
/** Device pixels per CSS pixel of an exported picture: sharp on a high-density screen and in print. */
export const PICTURE_SCALE = 2
/** The box the preview picture in the file fits into. */
export const THUMBNAIL_BOX = { width: 800, height: 600 } as const

/** The scale a picture of this size is drawn at: `wanted`, or less when the canvas would get too large. */
export function pictureScale(width: number, height: number, wanted = PICTURE_SCALE): number {
  return Math.min(
    wanted,
    MAX_SIDE / width,
    MAX_SIDE / height,
    Math.sqrt(MAX_PIXELS / (width * height)),
  )
}

/** The scale of the preview picture: the map made to fit the box, never enlarged. */
export function thumbnailScale(width: number, height: number): number {
  return Math.min(1, THUMBNAIL_BOX.width / width, THUMBNAIL_BOX.height / height)
}

function xmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** The copy as an SVG document of `scale` times its size. `element` stands in for the copy's own element. */
export function snapshotSvg(
  snapshot: MapSnapshot,
  scale: number,
  element: HTMLElement = snapshot.element,
): string {
  const { width, height } = snapshot
  const outWidth = Math.max(1, Math.round(width * scale))
  const outHeight = Math.max(1, Math.round(height * scale))
  const body = new XMLSerializer().serializeToString(element)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outWidth}" height="${outHeight}" viewBox="0 0 ${width} ${height}">` +
    `<foreignObject x="0" y="0" width="${width}" height="${height}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml"><style>${xmlText(exportStyles())}</style>${body}</div>` +
    '</foreignObject></svg>'
  )
}

/**
 * The copy's element with its pictures made the size they are drawn at
 * beforehand (`resample.ts`), so the picture comes out the same every time.
 */
async function withPicturesAt(snapshot: MapSnapshot, scale: number): Promise<HTMLElement> {
  const element = snapshot.element.cloneNode(true) as HTMLElement
  const originals = [...snapshot.element.querySelectorAll('img')]
  const copies = [...element.querySelectorAll('img')]
  await Promise.all(
    originals.map(async (img, index) => {
      const picture = snapshot.pictures.get(img)
      const copy = copies[index]
      const width = Number(img.getAttribute('width'))
      const height = Number(img.getAttribute('height'))
      if (!picture || !copy || !(width > 0) || !(height > 0)) return
      const sized = await pictureAtSize(
        picture.bytes,
        picture.type,
        Math.round(width * scale),
        Math.round(height * scale),
      )
      if (sized) copy.setAttribute('src', sized)
    }),
  )
  return element
}

/** The copy drawn as a PNG, `scale` device pixels to the CSS pixel. */
export async function snapshotPng(snapshot: MapSnapshot, scale: number): Promise<Uint8Array> {
  const svg = snapshotSvg(snapshot, scale, await withPicturesAt(snapshot, scale))
  const width = Math.max(1, Math.round(snapshot.width * scale))
  const height = Math.max(1, Math.round(snapshot.height * scale))
  // A `data:` address: an image from a `blob:` address of this page's scheme taints the canvas.
  const image = new Image(width, height)
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('no canvas to draw the picture in')
  context.drawImage(image, 0, 0, width, height)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('the picture could not be encoded')
  return new Uint8Array(await blob.arrayBuffer())
}

// ---- the page ----

const MM_TO_PX = 96 / 25.4
/** Landscape A4, a hair less tall than the sheet so that rounding never starts a second page. */
const PAGE = { widthMm: 297, heightMm: 209.5 } as const
const PAGE_MARGIN_MM = 10
/** A small map is enlarged on the page, but not beyond this. */
const MAX_PAGE_ENLARGE = 2

/** How a map of this size is fitted onto the page: the scale, and the size it then takes. */
export function pageFit(
  width: number,
  height: number,
): {
  scale: number
  width: number
  height: number
} {
  const roomWidth = (PAGE.widthMm - 2 * PAGE_MARGIN_MM) * MM_TO_PX
  const roomHeight = (PAGE.heightMm - 2 * PAGE_MARGIN_MM) * MM_TO_PX
  const scale = Math.min(MAX_PAGE_ENLARGE, roomWidth / width, roomHeight / height)
  return {
    scale,
    width: Math.floor(width * scale),
    height: Math.floor(height * scale),
  }
}

/** The page loads nothing: no script, no frame, no fetch, pictures from `data:` only. */
export const PAGE_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; " +
  "script-src 'none'; object-src 'none'; frame-src 'none'; connect-src 'none'; " +
  "base-uri 'none'; form-action 'none'"

const PAGE_CSS = `
@page { size: A4 landscape; margin: 0; }
html, body { margin: 0; padding: 0; }
.mm-page {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  width: ${PAGE.widthMm}mm;
  height: ${PAGE.heightMm}mm;
  padding: ${PAGE_MARGIN_MM}mm;
  overflow: hidden;
  background: var(--mm-page, transparent);
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.mm-fit { flex: none; position: relative; overflow: hidden; }
.mm-fit > .${EXPORT_CLASS} { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
`

/**
 * The copy on one landscape A4 page, fitted, in the map's ground colour: a
 * self-contained HTML document for the PDF and for the printer.
 */
export function snapshotPage(snapshot: MapSnapshot): string {
  const fit = pageFit(snapshot.width, snapshot.height)
  const map = snapshot.element.cloneNode(true) as HTMLElement
  map.style.transform = `scale(${fit.scale})`
  const ground = snapshot.ground ? ` style="--mm-page: ${snapshot.ground}"` : ''
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">`,
    `<style>${exportStyles()}${PAGE_CSS}</style>`,
    '</head>',
    '<body>',
    `<div class="mm-page"${ground}>`,
    `<div class="mm-fit" style="width: ${fit.width}px; height: ${fit.height}px">${map.outerHTML}</div>`,
    '</div>',
    '</body>',
    '</html>',
  ].join('\n')
}
