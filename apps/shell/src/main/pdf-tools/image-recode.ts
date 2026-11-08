/**
 * The picture code "make smaller" uses (apps/pdf/src/main/compress.ts):
 * Chromium's own decoder, resizer and JPEG encoder through nativeImage, which
 * only the main process has. One picture at a time with a turn of the event
 * loop before each, so a long document never holds the app still.
 */
import { nativeImage } from 'electron'
import { samplesToBgra, type ImageRecoder } from '../../../../pdf/src/main/compress'

export const recodeWithChromium: ImageRecoder = async (source, target) => {
  await new Promise((resolve) => setImmediate(resolve))
  const image =
    source.kind === 'jpeg'
      ? nativeImage.createFromBuffer(Buffer.from(source.bytes))
      : nativeImage.createFromBitmap(
          Buffer.from(
            samplesToBgra(source.samples, source.components, source.width * source.height),
          ),
          { width: source.width, height: source.height },
        )
  if (image.isEmpty()) return null
  const size = image.getSize()
  // a decoder that turned or misread the picture: keep the original
  if (size.width !== source.width || size.height !== source.height) return null
  const scale = Math.min(1, target.longSide / Math.max(size.width, size.height))
  const fitted =
    scale < 1
      ? image.resize({
          width: Math.max(1, Math.round(size.width * scale)),
          height: Math.max(1, Math.round(size.height * scale)),
          quality: 'good',
        })
      : image
  const out = fitted.getSize()
  return {
    jpeg: new Uint8Array(fitted.toJPEG(target.quality)),
    width: out.width,
    height: out.height,
  }
}
