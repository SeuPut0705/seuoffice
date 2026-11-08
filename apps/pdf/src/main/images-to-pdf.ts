/**
 * One PDF from JPEG and PNG images, one image per page in the given order
 * (the PDF tools window, decision 0030). pdf-lib embeds the image data as it
 * is, so a JPEG is not re-encoded and a photo keeps its quality. A JPEG's EXIF
 * orientation is applied, so a phone photo stands the way it was taken.
 */
import {
  PDFDocument,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
} from 'pdf-lib'

export type ImageKind = 'jpg' | 'png'

export interface ImageInfo {
  kind: ImageKind
  /** pixels as stored in the file */
  width: number
  height: number
  /** EXIF orientation 1-8 (1 for PNG and for JPEGs without one) */
  orientation: number
}

export interface ImagesToPdfOptions {
  /** page size in points (portrait), turned to landscape for a wide image; null: each page is its image's size */
  paper: { w: number; h: number } | null
  /** space kept clear on every side, in points (paper pages only) */
  marginPt: number
}

/** points per pixel when a page takes its image's size (96 dpi) */
const PT_PER_PX = 0.75
/** PDF viewers refuse pages larger than this many points on a side */
const MAX_PAGE_PT = 14_400

const u16 = (b: Uint8Array, at: number, little: boolean) =>
  little ? b[at]! | (b[at + 1]! << 8) : (b[at]! << 8) | b[at + 1]!
const u32 = (b: Uint8Array, at: number, little: boolean) =>
  little
    ? (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0
    : ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0

/** The orientation tag (0x0112) of an APP1 Exif segment's TIFF data, or 1 */
function exifOrientation(b: Uint8Array, tiff: number, end: number): number {
  if (tiff + 8 > end) return 1
  const little = b[tiff] === 0x49 && b[tiff + 1] === 0x49
  if (!little && !(b[tiff] === 0x4d && b[tiff + 1] === 0x4d)) return 1
  const ifd = tiff + u32(b, tiff + 4, little)
  if (ifd + 2 > end) return 1
  const count = u16(b, ifd, little)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > end) return 1
    if (u16(b, entry, little) === 0x0112) {
      const value = u16(b, entry + 8, little)
      return value >= 1 && value <= 8 ? value : 1
    }
  }
  return 1
}

function jpegInfo(b: Uint8Array): ImageInfo | null {
  let orientation = 1
  let at = 2
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null
    const marker = b[at + 1]!
    // fill bytes and markers without a length
    if (marker === 0xff) {
      at++
      continue
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2
      continue
    }
    const length = u16(b, at + 2, false)
    if (length < 2 || at + 2 + length > b.length) return null
    const body = at + 4
    const end = at + 2 + length
    // APP1 "Exif\0\0"
    if (
      marker === 0xe1 &&
      end - body > 6 &&
      b[body] === 0x45 &&
      b[body + 1] === 0x78 &&
      b[body + 2] === 0x69 &&
      b[body + 3] === 0x66
    ) {
      orientation = exifOrientation(b, body + 6, end)
    }
    // a start-of-frame marker carries the size (not DHT C4, JPG C8, DAC CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (end - body < 5) return null
      const height = u16(b, body + 1, false)
      const width = u16(b, body + 3, false)
      return width > 0 && height > 0 ? { kind: 'jpg', width, height, orientation } : null
    }
    if (marker === 0xda) return null
    at = end
  }
  return null
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** What an image file is and its size, read from its header; null: not a JPEG or PNG */
export function readImageInfo(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegInfo(bytes)
  if (bytes.length >= 24 && PNG_SIGNATURE.every((v, i) => bytes[i] === v)) {
    // IHDR is the first chunk: width and height right after its type
    const width = u32(bytes, 16, false)
    const height = u32(bytes, 20, false)
    return width > 0 && height > 0 ? { kind: 'png', width, height, orientation: 1 } : null
  }
  return null
}

/** Orientations 5-8 turn the image a quarter, so it shows with width and height swapped */
const turnsQuarter = (orientation: number) => orientation >= 5

/**
 * The matrix that draws the image's unit square into the box (x, y, w, h) the
 * way EXIF `orientation` says it is meant to be seen.
 */
export function orientedImageMatrix(
  orientation: number,
  x: number,
  y: number,
  w: number,
  h: number,
): [number, number, number, number, number, number] {
  switch (orientation) {
    case 2:
      return [-w, 0, 0, h, x + w, y]
    case 3:
      return [-w, 0, 0, -h, x + w, y + h]
    case 4:
      return [w, 0, 0, -h, x, y + h]
    case 5:
      return [0, -h, -w, 0, x + w, y + h]
    case 6:
      return [0, -h, w, 0, x, y + h]
    case 7:
      return [0, h, w, 0, x, y]
    case 8:
      return [0, h, -w, 0, x + w, y]
    default:
      return [w, 0, 0, h, x, y]
  }
}

/** Pages of `images` (JPEG or PNG bytes) in order; throws on an image it cannot read */
export async function imagesToPdfBytes(
  images: Uint8Array[],
  options: ImagesToPdfOptions,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (const bytes of images) {
    const info = readImageInfo(bytes)
    if (!info) throw new Error('not a JPEG or PNG image')
    const image = info.kind === 'jpg' ? await doc.embedJpg(bytes) : await doc.embedPng(bytes)
    const quarter = turnsQuarter(info.orientation)
    // the image as it is meant to be seen
    const shownW = quarter ? image.height : image.width
    const shownH = quarter ? image.width : image.height

    let pageW: number
    let pageH: number
    let box: { x: number; y: number; w: number; h: number }
    if (options.paper) {
      const wide = shownW > shownH
      pageW = wide ? options.paper.h : options.paper.w
      pageH = wide ? options.paper.w : options.paper.h
      const margin = Math.max(0, Math.min(options.marginPt, pageW / 4, pageH / 4))
      const room = { w: pageW - margin * 2, h: pageH - margin * 2 }
      const scale = Math.min(room.w / shownW, room.h / shownH)
      const w = shownW * scale
      const h = shownH * scale
      box = { x: (pageW - w) / 2, y: (pageH - h) / 2, w, h }
    } else {
      const scale = Math.min(PT_PER_PX, MAX_PAGE_PT / shownW, MAX_PAGE_PT / shownH)
      pageW = shownW * scale
      pageH = shownH * scale
      box = { x: 0, y: 0, w: pageW, h: pageH }
    }

    const page = doc.addPage([pageW, pageH])
    const name = page.node.newXObject('Image', image.ref)
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(
        ...orientedImageMatrix(info.orientation, box.x, box.y, box.w, box.h),
      ),
      drawObject(name),
      popGraphicsState(),
    )
  }
  return doc.save({ useObjectStreams: false })
}
