/**
 * Background overlay (the PDF tools window, decision 0030): one page of
 * another PDF drawn behind or in front of a document's pages, such as a
 * letterhead under every page. The background page is fitted inside each
 * page's visible box, centred, keeping its proportions, and stands upright on
 * a page saved with /Rotate.
 */
import {
  PDFArray,
  PDFDocument,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
} from 'pdf-lib'

export interface OverlayOptions {
  /** draw under the page's own content (true) or over it */
  behind: boolean
  /** 0-based page of the background PDF to draw */
  backgroundPage: number
  /** 0-based pages to draw it on; null: every page */
  pages: number[] | null
}

type Matrix = [number, number, number, number, number, number]

/**
 * The matrix that draws a `w` × `h` form inside `box` (the page's visible box
 * in its own unrotated space), fitted and centred as the page is seen after
 * turning it `rotation` degrees clockwise.
 */
export function overlayMatrix(
  rotation: number,
  box: { x: number; y: number; width: number; height: number },
  w: number,
  h: number,
): Matrix {
  const turn = (((Math.round(rotation / 90) * 90) % 360) + 360) % 360
  const quarter = turn === 90 || turn === 270
  const seenW = quarter ? box.height : box.width
  const seenH = quarter ? box.width : box.height
  const s = Math.min(seenW / w, seenH / h)
  // the form's corner in the page as seen
  const ox = (seenW - w * s) / 2
  const oy = (seenH - h * s) / 2
  const { x, y, width: W, height: H } = box
  switch (turn) {
    case 90:
      return [0, s, -s, 0, x + W - oy, y + ox]
    case 180:
      return [-s, 0, 0, -s, x + W - ox, y + H - oy]
    case 270:
      return [0, -s, s, 0, x + oy, y + H - ox]
    default:
      return [s, 0, 0, s, x + ox, y + oy]
  }
}

/** `doc` with page `backgroundPage` of `background` drawn on the chosen pages */
export async function overlayPdfBytes(
  doc: Uint8Array,
  background: Uint8Array,
  options: OverlayOptions,
): Promise<Uint8Array> {
  const out = await PDFDocument.load(doc, { updateMetadata: false })
  const bg = await PDFDocument.load(background, { updateMetadata: false })
  const source = bg.getPage(options.backgroundPage)
  // a page with no content draws nothing (and pdf-lib cannot embed it)
  if (!source.node.Contents()) return out.save({ useObjectStreams: false })
  const [form] = await out.embedPdf(bg, [options.backgroundPage])
  if (!form) throw new Error('no such background page')
  const count = out.getPageCount()
  const targets = (options.pages ?? out.getPageIndices()).filter((i) => i >= 0 && i < count)
  for (const index of new Set(targets)) {
    const page = out.getPage(index)
    const name = page.node.newXObject('Background', form.ref)
    const operators = [
      pushGraphicsState(),
      concatTransformationMatrix(
        ...overlayMatrix(page.getRotation().angle, page.getCropBox(), form.width, form.height),
      ),
      drawObject(name),
      popGraphicsState(),
    ]
    if (!options.behind) {
      // pdf-lib wraps the page's own content in q … Q first, so its state ends before ours
      page.pushOperators(...operators)
      continue
    }
    // a stream of our own ahead of everything the page draws
    page.node.normalize()
    const stream = out.context.register(out.context.contentStream(operators))
    const contents = page.node.Contents()
    if (contents instanceof PDFArray) contents.insert(0, stream)
    else page.node.addContentStream(stream)
  }
  return out.save({ useObjectStreams: false })
}
