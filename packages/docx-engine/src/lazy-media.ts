/**
 * Lazy media: a large document's browser-renderable pictures stay in the file
 * on disk instead of travelling into the renderer. The zip handed to the
 * renderer carries a fixed-size placeholder per stripped part naming the
 * source document's sha256; the picture is then referenced by URL and served
 * from the original file, and a save swaps the placeholders back for the
 * original bytes (see zip-splice.ts).
 */
import { invoke } from './engine'

export const LAZY_MEDIA_SCHEME = 'seuoffice-docx-media'
const MAGIC = 'SEUOFFICE-LAZY-MEDIA\n'
export const LAZY_MEDIA_PLACEHOLDER_BYTES = MAGIC.length + 64 + 1
export function lazyMediaPlaceholder(hash: string): Uint8Array {
  return invoke('lazyMediaPlaceholder', [hash]) as never
}
export function lazyMediaHashOf(bytes: Uint8Array): string | null {
  return invoke('lazyMediaHashOf', [bytes]) as never
}
/** pictures Chromium decodes itself; emf/wmf/tiff need their bytes in the renderer */
export function isLazyMediaPart(partPath: string): boolean {
  return invoke('isLazyMediaPart', [partPath]) as never
}
/** Max lazy-media part path chars served from the source archive. */
export const MAX_LAZY_PART_CHARS = 512
export function lazyMediaUrl(hash: string, partPath: string): string {
  return invoke('lazyMediaUrl', [hash, partPath]) as never
}
export function parseLazyMediaUrl(url: string): { hash: string; partPath: string } | null {
  return invoke('parseLazyMediaUrl', [url]) as never
}