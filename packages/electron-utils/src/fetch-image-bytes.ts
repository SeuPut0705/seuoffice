/**
 * One picture for an editor, from either place an AI picture arrives: a web
 * address the model found, or the file the image generator wrote into its own
 * store. `fetchRemoteImage` is the gate for both — it answers a `file:` URL
 * only when it names a file of the generated-image store (readGeneratedImage)
 * and validates every hop of an http(s) download. Callers must not add a
 * `^https?:` test in front of it: that check turns a generated picture into a
 * hot-linked `file://` src the page can never load.
 */
import { fetchRemoteImage, MAX_REMOTE_IMAGE_BYTES, readBodyCapped } from './remote-image'

/** The formats the editors' insert paths accept; anything else is downloaded as JPEG. */
export type FetchedImageMime = 'image/png' | 'image/jpeg' | 'image/gif'

export interface FetchedImageBytes {
  base64: string
  mime: FetchedImageMime
}

export async function fetchImageBytes(url: unknown): Promise<FetchedImageBytes | null> {
  if (typeof url !== 'string' || url === '') return null
  try {
    const resp = await fetchRemoteImage(url)
    if (!resp?.ok) return null
    const ct = resp.headers.get('content-type') ?? ''
    // remoteImageHeaders advertises only png/jpeg/gif, so anything else is a
    // mislabelled JPEG — the same rule the document editors' insert paths use
    const mime: FetchedImageMime = ct.includes('png')
      ? 'image/png'
      : ct.includes('gif')
        ? 'image/gif'
        : 'image/jpeg'
    const bytes = await readBodyCapped(resp, MAX_REMOTE_IMAGE_BYTES)
    return { base64: Buffer.from(bytes).toString('base64'), mime }
  } catch {
    return null
  }
}
