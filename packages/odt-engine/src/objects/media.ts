/**
 * Picture bytes: format sniffing, base64 and data URLs (no Node builtins),
 * and the neutral placeholder picture.
 */

export interface ImageFormat {
  /** file extension without the dot */
  ext: string
  mime: string
}

/**
 * The neutral placeholder picture: a 1×1 light grey PNG, stretched to the
 * object's size. Language-neutral; the editor draws the localized label.
 */
export const NEUTRAL_PLACEHOLDER_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x78, 0xf1, 0xe2, 0x05,
  0x00, 0x05, 0x74, 0x02, 0xb9, 0xe7, 0x3f, 0x14, 0xc9, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
])

const at = (b: Uint8Array, offset: number, bytes: number[]) =>
  bytes.every((v, i) => b[offset + i] === v)

/** The format of picture bytes the bridge docx can show, or null (SVM, unknown …). */
export function sniffImage(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length < 4) return null
  if (at(bytes, 0, [0x89, 0x50, 0x4e, 0x47])) return { ext: 'png', mime: 'image/png' }
  if (at(bytes, 0, [0xff, 0xd8, 0xff])) return { ext: 'jpeg', mime: 'image/jpeg' }
  if (at(bytes, 0, [0x47, 0x49, 0x46, 0x38])) return { ext: 'gif', mime: 'image/gif' }
  if (at(bytes, 0, [0x42, 0x4d])) return { ext: 'bmp', mime: 'image/bmp' }
  if (at(bytes, 0, [0x49, 0x49, 0x2a, 0x00]) || at(bytes, 0, [0x4d, 0x4d, 0x00, 0x2a]))
    return { ext: 'tiff', mime: 'image/tiff' }
  // EMF: EMR_HEADER record type 1, " EMF" signature at 40
  if (at(bytes, 0, [0x01, 0x00, 0x00, 0x00]) && at(bytes, 40, [0x20, 0x45, 0x4d, 0x46]))
    return { ext: 'emf', mime: 'image/x-emf' }
  // WMF: placeable header, or a plain memory/disk metafile header
  if (
    at(bytes, 0, [0xd7, 0xcd, 0xc6, 0x9a]) ||
    ((at(bytes, 0, [0x01, 0x00]) || at(bytes, 0, [0x02, 0x00])) && at(bytes, 2, [0x09, 0x00]))
  )
    return { ext: 'wmf', mime: 'image/x-wmf' }
  const head = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 512)))
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/.test(head))
    return { ext: 'svg', mime: 'image/svg+xml' }
  return null
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function base64Encode(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)]
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '='
    out += i + 2 < bytes.length ? B64[c & 63] : '='
  }
  return out
}

const B64_INDEX = (() => {
  const t = new Int16Array(128).fill(-1)
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i
  t['-'.charCodeAt(0)] = 62
  t['_'.charCodeAt(0)] = 63
  return t
})()

/** Decodes base64 (white space ignored); null when it is not base64. */
export function base64Decode(text: string): Uint8Array | null {
  const clean = text.replace(/[\s=]+/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let n = 0
  let acc = 0
  let bits = 0
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i)
    const v = code < 128 ? B64_INDEX[code] : -1
    if (v < 0) return null
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[n++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, n)
}

/** The bytes of a `data:…;base64,…` URL, or null (lazy media URLs, other schemes). */
export function dataUrlBytes(url: string | undefined): Uint8Array | null {
  if (!url) return null
  const m = /^data:[^,]*?;base64,(.*)$/s.exec(url)
  return m ? base64Decode(m[1]) : null
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
