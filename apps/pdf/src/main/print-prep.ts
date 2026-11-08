/**
 * Preparing PDFs for printing (the PDF tools window, decision 0030).
 */
import { PDFDocument } from 'pdf-lib'

/** Blank pages that bring `count` up to a multiple of `multiple` */
export function blankPagesToAdd(count: number, multiple: number): number {
  const unit = Math.max(1, Math.floor(multiple))
  return (unit - (count % unit)) % unit
}

/**
 * One PDF from `files` in order, each padded with blank pages to a multiple
 * of `multiple` pages, so every file starts on the front of a new sheet when
 * the whole is printed on both sides (2), or on both sides `n` up (2 × n).
 * A blank page takes the size and rotation of its file's last page.
 */
export async function duplexMergeBytes(files: Uint8Array[], multiple: number): Promise<Uint8Array> {
  const out = await PDFDocument.create()
  for (const bytes of files) {
    const src = await PDFDocument.load(bytes, { updateMetadata: false })
    const copied = await out.copyPages(src, src.getPageIndices())
    for (const page of copied) out.addPage(page)
    const last = copied[copied.length - 1]
    if (!last) continue
    for (let i = blankPagesToAdd(copied.length, multiple); i > 0; i--) {
      const blank = out.addPage([last.getWidth(), last.getHeight()])
      // match /Rotate too, or the blank page turns sideways next to its neighbour
      blank.setRotation(last.getRotation())
    }
  }
  return out.save({ useObjectStreams: false })
}
