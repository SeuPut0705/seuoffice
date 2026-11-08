/**
 * Make a PDF smaller (the PDF tools window, decision 0030): large pictures
 * are shrunk and stored again as JPEG, and the file is written with object
 * streams. Text and drawings are not touched.
 *
 * The picture work itself (decode, resize, JPEG encode) is the caller's: the
 * app hands in Chromium's image code, which only the main process has. This
 * module decides which pictures to try, what to ask for, and keeps a new
 * picture only when it came out smaller.
 *
 * Left alone: pictures with transparency drawn by a colour key (/Mask) or a
 * /Decode array, image masks, CMYK and other colour spaces, more than 8 bits a
 * sample, filters other than one DCTDecode or FlateDecode, and Flate data with
 * a predictor (pdf-lib cannot undo predictors), soft masks themselves, and
 * JPEGs carrying an EXIF orientation (a decoder may turn them; PDF does not).
 * A picture's soft mask (/SMask) is kept as it is; PDF draws it at its own size.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
} from 'pdf-lib'
import { readImageInfo } from './images-to-pdf'

export const COMPRESS_LEVELS = ['light', 'medium', 'strong'] as const
export type CompressLevel = (typeof COMPRESS_LEVELS)[number]

/** Longest side in pixels and JPEG quality each level asks for */
export const LEVEL_TARGETS: Record<CompressLevel, { longSide: number; quality: number }> = {
  light: { longSide: 3000, quality: 85 },
  medium: { longSide: 2000, quality: 75 },
  strong: { longSide: 1400, quality: 60 },
}

/** A picture to shrink: JPEG bytes, or 8-bit samples (1 = grey, 3 = RGB) */
export type SourceImage =
  | { kind: 'jpeg'; bytes: Uint8Array; width: number; height: number }
  | { kind: 'raw'; samples: Uint8Array; width: number; height: number; components: 1 | 3 }

export interface RecodedImage {
  jpeg: Uint8Array
  width: number
  height: number
}

/**
 * The caller's picture code: `image` shrunk to fit `longSide` (never grown)
 * and encoded as an RGB JPEG at `quality`; null when it cannot.
 */
export type ImageRecoder = (
  image: SourceImage,
  target: { longSide: number; quality: number },
) => Promise<RecodedImage | null>

export interface CompressResult {
  bytes: Uint8Array
  /** pictures stored again smaller */
  recoded: number
}

/** pictures smaller than this are left as they are: little to win */
const MIN_STREAM_BYTES = 48 * 1024

/** a stream's single filter name, '' for none, null for a chain */
function singleFilter(dict: PDFDict): string | null {
  const filter = dict.lookup(PDFName.of('Filter'))
  if (!filter) return ''
  if (filter instanceof PDFName) return filter.decodeText()
  if (filter instanceof PDFArray) {
    if (filter.size() === 0) return ''
    if (filter.size() !== 1) return null
    const only = filter.lookup(0)
    return only instanceof PDFName ? only.decodeText() : null
  }
  return null
}

/** 1 for grey, 3 for RGB (device or ICC based), null for anything else */
function componentsOf(dict: PDFDict): { components: 1 | 3; icc: boolean } | null {
  const cs = dict.lookup(PDFName.of('ColorSpace'))
  if (cs instanceof PDFName) {
    const name = cs.decodeText()
    if (name === 'DeviceRGB') return { components: 3, icc: false }
    if (name === 'DeviceGray') return { components: 1, icc: false }
    return null
  }
  if (cs instanceof PDFArray && cs.size() === 2) {
    const kind = cs.lookup(0)
    const profile = cs.lookup(1)
    if (!(kind instanceof PDFName) || kind.decodeText() !== 'ICCBased') return null
    const n = profile instanceof PDFRawStream ? profile.dict.lookup(PDFName.of('N')) : undefined
    const count = n instanceof PDFNumber ? n.asNumber() : 0
    if (count === 3) return { components: 3, icc: true }
    if (count === 1) return { components: 1, icc: true }
  }
  return null
}

const numberOf = (dict: PDFDict, key: string): number | null => {
  const v = dict.lookup(PDFName.of(key))
  return v instanceof PDFNumber ? v.asNumber() : null
}

/** A picture this module may try, read into what the recoder takes; null to leave it */
export function sourceOf(stream: PDFRawStream): SourceImage | null {
  const { dict } = stream
  const subtype = dict.lookup(PDFName.of('Subtype'))
  if (!(subtype instanceof PDFName) || subtype.decodeText() !== 'Image') return null
  if (dict.lookup(PDFName.of('ImageMask'))?.toString() === 'true') return null
  if (dict.has(PDFName.of('Mask')) || dict.has(PDFName.of('Decode'))) return null
  if (numberOf(dict, 'BitsPerComponent') !== 8) return null
  const width = numberOf(dict, 'Width')
  const height = numberOf(dict, 'Height')
  if (!width || !height || width < 1 || height < 1) return null
  if (stream.getContentsSize() < MIN_STREAM_BYTES) return null
  const colour = componentsOf(dict)
  if (!colour) return null
  const filter = singleFilter(dict)
  if (filter === 'DCTDecode') {
    const jpeg = stream.getContents()
    // a decoder may turn a JPEG by its EXIF orientation, which PDF ignores
    const info = readImageInfo(jpeg)
    if (!info || info.orientation !== 1) return null
    return { kind: 'jpeg', bytes: jpeg, width, height }
  }
  if (filter !== 'FlateDecode') return null
  const parms = dict.lookup(PDFName.of('DecodeParms'))
  const predictor =
    parms instanceof PDFDict
      ? parms.lookup(PDFName.of('Predictor'))
      : parms instanceof PDFArray
        ? parms.lookupMaybe(0, PDFDict)?.lookup(PDFName.of('Predictor'))
        : undefined
  if (predictor instanceof PDFNumber && predictor.asNumber() > 1) return null
  const samples = decodePDFRawStream(stream).decode()
  if (samples.length < width * height * colour.components) return null
  return { kind: 'raw', samples, width, height, components: colour.components }
}

/** 8-bit grey or RGB samples as the BGRA pixels a bitmap API takes */
export function samplesToBgra(samples: Uint8Array, components: 1 | 3, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels * 4)
  for (let i = 0; i < pixels; i++) {
    const r = samples[i * components]!
    const g = components === 3 ? samples[i * 3 + 1]! : r
    const b = components === 3 ? samples[i * 3 + 2]! : r
    out[i * 4] = b
    out[i * 4 + 1] = g
    out[i * 4 + 2] = r
    out[i * 4 + 3] = 255
  }
  return out
}

/** Keep what the picture's dictionary says beyond its data and format */
const DROPPED = new Set([
  'Length',
  'Filter',
  'DecodeParms',
  'Width',
  'Height',
  'BitsPerComponent',
  'ColorSpace',
])

/**
 * `bytes` with its large pictures shrunk at `level`. The file is written with
 * object streams either way, so it may come out smaller with no picture
 * touched. `onProgress` counts the pictures tried; a throw from `signal`
 * stops the work.
 */
export async function compressPdfBytes(
  bytes: Uint8Array,
  level: CompressLevel,
  recode: ImageRecoder,
  options: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<CompressResult> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const { context } = doc
  const target = LEVEL_TARGETS[level]
  const objects = context.enumerateIndirectObjects()
  // a soft mask is a grey picture itself, and must stay one
  const masks = new Set<string>()
  for (const [, object] of objects) {
    const mask = object instanceof PDFRawStream ? object.dict.get(PDFName.of('SMask')) : undefined
    if (mask instanceof PDFRef) masks.add(mask.toString())
  }
  const pictures: [PDFRef, PDFRawStream, SourceImage][] = []
  for (const [ref, object] of objects) {
    if (!(object instanceof PDFRawStream) || masks.has(ref.toString())) continue
    let source: SourceImage | null
    try {
      source = sourceOf(object)
    } catch {
      // data that does not decode is left as it is
      source = null
    }
    if (source) pictures.push([ref, object, source])
  }
  let recoded = 0
  for (const [i, [ref, stream, source]] of pictures.entries()) {
    options.signal?.throwIfAborted()
    const made = await recode(source, target)
    if (made && made.jpeg.length < stream.getContentsSize()) {
      const keep = colourKept(stream.dict)
      const dict = context.obj({})
      for (const [key, value] of stream.dict.entries()) {
        if (!DROPPED.has(key.decodeText())) dict.set(key, value)
      }
      dict.set(PDFName.of('Width'), PDFNumber.of(made.width))
      dict.set(PDFName.of('Height'), PDFNumber.of(made.height))
      dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8))
      dict.set(PDFName.of('ColorSpace'), keep ?? PDFName.of('DeviceRGB'))
      dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'))
      context.assign(ref, PDFRawStream.of(dict, made.jpeg))
      recoded++
    }
    options.onProgress?.(i + 1, pictures.length)
  }
  return { bytes: await doc.save({ useObjectStreams: true }), recoded }
}

/** an RGB ICC profile stays with the picture; grey becomes RGB (the recoder writes RGB) */
function colourKept(dict: PDFDict) {
  const colour = componentsOf(dict)
  return colour?.icc && colour.components === 3 ? dict.get(PDFName.of('ColorSpace')) : undefined
}
