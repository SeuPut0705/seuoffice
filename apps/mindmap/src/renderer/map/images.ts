/**
 * The pictures of a map: which ones are shown, and how.
 *
 * Only a picture that lives inside the map file is shown: a reference to an
 * entry under `resources/` in the archive. A reference to anything else (a web
 * address, a path on this computer, a `data:` address, any other scheme) is
 * never loaded and never becomes the source of an element; the topic shows a
 * mark that a picture belongs there, and the file keeps its value.
 *
 * A picture that is shown goes through an `<img>` element fed from the bytes
 * the engine reads out of the archive, as an object URL of a type this module
 * recognised from the bytes themselves. An SVG picture is shown the same way
 * and only that way: as an image resource it runs no script and loads nothing,
 * neither from the file nor from the network. It is never parsed into the
 * page. Whatever the bytes turn out to be, the page's content policy lets an
 * image come from the page itself, `data:` and `blob:` only.
 *
 * Object URLs are kept per entry and revoked when the store is destroyed.
 */
import type { ViewImage } from '@genoffice/xmind-engine'

/** The folder of the archive pictures live in. */
const RESOURCE_FOLDER = 'resources/'

/** A reference into the archive that names an entry under `resources/` and nothing that could leave it. */
export function archivePictureEntry(image: ViewImage | null | undefined): string | null {
  const name = image?.entryName
  if (typeof name !== 'string' || !name.startsWith(RESOURCE_FOLDER)) return null
  const rest = name.slice(RESOURCE_FOLDER.length)
  if (rest === '' || rest.includes('\\') || rest.includes(':')) return null
  // no way up or out of the folder, and no empty step
  if (rest.split('/').some((step) => step === '' || step === '.' || step === '..')) return null
  // a control character has no place in an entry name
  for (let at = 0; at < rest.length; at++) if (rest.charCodeAt(at) < 0x20) return null
  return name
}

/** The picture types shown, told from the first bytes. Null: not a picture this app shows. */
export function pictureType(bytes: Uint8Array): string | null {
  const starts = (...signature: number[]): boolean =>
    signature.every((byte, index) => bytes[index] === byte)
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (starts(0x42, 0x4d)) return 'image/bmp'
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return looksLikeSvg(bytes) ? 'image/svg+xml' : null
}

/** Text whose first element is `<svg`, after an optional byte order mark, XML declaration, SVG doctype and comments. */
function looksLikeSvg(bytes: Uint8Array): boolean {
  let head: string
  try {
    head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 4096))
  } catch {
    return false
  }
  const text = head
    .replace(/^\uFEFF/, '')
    .replace(/^\s*<\?xml[^>]*\?>/i, '')
    .replace(/^(?:\s*<!--[\s\S]*?-->)*/, '')
    .replace(/^\s*<!DOCTYPE\s+svg\b[^>[]*>/i, '')
    .replace(/^(?:\s*<!--[\s\S]*?-->)*/, '')
  return /^\s*<svg[\s>]/i.test(text)
}

/** Reads the bytes of an archive entry; null when there is no such entry. */
export type EntryReader = (entryName: string) => Promise<Uint8Array | null>

/** The widest and tallest a picture is drawn on a topic (CSS pixels). */
export const PICTURE_MAX = { width: 320, height: 240 } as const

/**
 * The size a picture is drawn at when the file gives one: the file's numbers,
 * scaled down together to fit `PICTURE_MAX`. Null when the file gives none
 * that can be used; the picture then takes its own size inside the same limit.
 */
export function pictureBox(image: ViewImage): { width: number; height: number } | null {
  const { width, height } = image
  if (width === null || height === null) return null
  if (!(width >= 1) || !(height >= 1) || width > 20_000 || height > 20_000) return null
  const scale = Math.min(1, PICTURE_MAX.width / width, PICTURE_MAX.height / height)
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

/**
 * The pictures of one map on screen: object URLs for the archive entries that
 * were asked for, made once each.
 */
export class PictureStore {
  readonly #read: EntryReader
  readonly #pending = new Map<string, Promise<string | null>>()
  readonly #ready = new Map<string, string | null>()
  readonly #urls: string[] = []
  #destroyed = false

  constructor(read: EntryReader) {
    this.#read = read
  }

  /** The object URL of an entry that was already loaded; undefined while it is not known yet. */
  peek(entryName: string): string | null | undefined {
    return this.#ready.get(entryName)
  }

  /** The object URL of an archive entry, or null when the entry is missing or is no picture. */
  load(entryName: string): Promise<string | null> {
    let pending = this.#pending.get(entryName)
    if (!pending) {
      pending = this.#make(entryName).then((url) => {
        this.#ready.set(entryName, url)
        return url
      })
      this.#pending.set(entryName, pending)
    }
    return pending
  }

  async #make(entryName: string): Promise<string | null> {
    let bytes: Uint8Array | null
    try {
      bytes = await this.#read(entryName)
    } catch {
      return null
    }
    if (!bytes || this.#destroyed) return null
    const type = pictureType(bytes)
    if (!type) return null
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }))
    if (this.#destroyed) {
      URL.revokeObjectURL(url)
      return null
    }
    this.#urls.push(url)
    return url
  }

  /** Gives every object URL back. Pictures still on screen lose their source. */
  destroy(): void {
    this.#destroyed = true
    for (const url of this.#urls.splice(0)) URL.revokeObjectURL(url)
    this.#pending.clear()
    this.#ready.clear()
  }
}
