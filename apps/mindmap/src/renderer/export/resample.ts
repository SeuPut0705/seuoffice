/**
 * Making a picture of the file smaller for an exported PNG, the same way every
 * time.
 *
 * When the browser draws a picture at another size than its own, how it
 * filters can depend on what it drew before (it keeps copies at other sizes
 * around), so two exports of the same map could differ in a few pixels of a
 * picture. A picture that goes into a PNG is therefore made the size it is
 * drawn at here first: a raster picture that is made smaller by averaging the
 * pixels it covers, an SVG picture by drawing it as an image at that size.
 * The browser then draws it pixel for pixel.
 */
import { base64Of } from './snapshot'

/**
 * RGBA pixels made `toWidth` by `toHeight` by area averaging: each pixel of the
 * result is the mean of the part of the picture it covers, weighted by alpha.
 * For making smaller; a size larger than the source is not asked for.
 */
export function shrinkPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  toWidth: number,
  toHeight: number,
): Uint8ClampedArray<ArrayBuffer> {
  // across: premultiplied sums, one row of the source at a time
  const across = new Float64Array(toWidth * height * 4)
  const stepX = width / toWidth
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < toWidth; x++) {
      const from = x * stepX
      const to = from + stepX
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sx = Math.floor(from); sx < Math.min(width, Math.ceil(to)); sx++) {
        const cover = Math.min(to, sx + 1) - Math.max(from, sx)
        if (cover <= 0) continue
        const at = (y * width + sx) * 4
        const alpha = (pixels[at + 3]! / 255) * cover
        r += pixels[at]! * alpha
        g += pixels[at + 1]! * alpha
        b += pixels[at + 2]! * alpha
        a += alpha
      }
      const out = (y * toWidth + x) * 4
      across[out] = r / stepX
      across[out + 1] = g / stepX
      across[out + 2] = b / stepX
      across[out + 3] = a / stepX
    }
  }
  // down: the rows of that, then back from premultiplied
  const result = new Uint8ClampedArray(toWidth * toHeight * 4)
  const stepY = height / toHeight
  for (let y = 0; y < toHeight; y++) {
    const from = y * stepY
    const to = from + stepY
    for (let x = 0; x < toWidth; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = Math.floor(from); sy < Math.min(height, Math.ceil(to)); sy++) {
        const cover = Math.min(to, sy + 1) - Math.max(from, sy)
        if (cover <= 0) continue
        const at = (sy * toWidth + x) * 4
        r += across[at]! * cover
        g += across[at + 1]! * cover
        b += across[at + 2]! * cover
        a += across[at + 3]! * cover
      }
      const out = (y * toWidth + x) * 4
      const alpha = a / stepY
      result[out] = alpha > 0 ? r / stepY / alpha : 0
      result[out + 1] = alpha > 0 ? g / stepY / alpha : 0
      result[out + 2] = alpha > 0 ? b / stepY / alpha : 0
      result[out + 3] = alpha * 255
    }
  }
  return result
}

/** The most pixels a picture may have to be made smaller here; a larger one is left to the browser. */
const MAX_SOURCE_PIXELS = 40_000_000

/** The size a picture of `width` by `height` takes inside a box, keeping its shape (`object-fit: contain`). */
export function containedSize(
  width: number,
  height: number,
  boxWidth: number,
  boxHeight: number,
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: boxWidth, height: boxHeight }
  const scale = Math.min(boxWidth / width, boxHeight / height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function canvasOf(width: number, height: number): CanvasRenderingContext2D | null {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas.getContext('2d')
}

/**
 * A picture of the file as a PNG `data:` address of exactly `boxWidth` by
 * `boxHeight` pixels, the picture centred in it at the largest size that
 * keeps its shape, as the page shows it. Null when it is to be left to the
 * browser: a raster picture that is not made smaller, one too large to hold,
 * one that cannot be decoded.
 *
 * An SVG picture is drawn into the canvas as an image, at the size wanted: as
 * an image it runs nothing and loads nothing.
 */
export async function pictureAtSize(
  bytes: Uint8Array,
  type: string,
  boxWidth: number,
  boxHeight: number,
): Promise<string | null> {
  if (!(boxWidth >= 1) || !(boxHeight >= 1)) return null
  const target = canvasOf(boxWidth, boxHeight)
  if (!target) return null

  if (type === 'image/svg+xml') {
    try {
      const image = new Image()
      // a `data:` address: an image from a `blob:` address of this page's scheme taints the canvas
      image.src = `data:image/svg+xml;base64,${base64Of(bytes)}`
      await image.decode()
      const size = containedSize(image.naturalWidth, image.naturalHeight, boxWidth, boxHeight)
      target.drawImage(
        image,
        Math.floor((boxWidth - size.width) / 2),
        Math.floor((boxHeight - size.height) / 2),
        size.width,
        size.height,
      )
      return target.canvas.toDataURL('image/png')
    } catch {
      return null
    }
  }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type }))
  } catch {
    return null
  }
  try {
    const { width, height } = bitmap
    const size = containedSize(width, height, boxWidth, boxHeight)
    if (size.width >= width || size.height >= height || width * height > MAX_SOURCE_PIXELS) {
      return null
    }
    const source = canvasOf(width, height)
    if (!source) return null
    source.drawImage(bitmap, 0, 0)
    const pixels = source.getImageData(0, 0, width, height).data
    target.putImageData(
      new ImageData(
        shrinkPixels(pixels, width, height, size.width, size.height),
        size.width,
        size.height,
      ),
      Math.floor((boxWidth - size.width) / 2),
      Math.floor((boxHeight - size.height) / 2),
    )
    return target.canvas.toDataURL('image/png')
  } finally {
    bitmap.close()
  }
}
