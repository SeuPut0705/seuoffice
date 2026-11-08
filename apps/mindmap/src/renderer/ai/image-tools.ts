/**
 * The map's picture tools: image_search (read-only) and insert_image /
 * generate_image, which bring the bytes into the map file and put them on one
 * topic.
 *
 * Nothing here writes to the source tree. The bytes become a new entry of the
 * document (`DocumentSession.addPicture`), and the topic is changed through
 * `setTopicImage`, which goes the same way as every other AI edit: the library
 * tree, `MapController.edit`, reconciling and one step of the undo history.
 * A picture that does not land takes its entry back out, so a failed edit
 * leaves neither a reference nor bytes behind.
 *
 * Addresses are fetched in the main process: a search result is an http(s)
 * URL, and the generator answers with a file of the app's own store. The
 * fetch gate there decides which of those may be read.
 */
import {
  setTopicImage,
  type MapAiHost,
  type MapToolResult,
  type MapTurn,
  type PictureBytes,
} from './map-tools'

/** The largest picture written into a map file; the store and the attachment reader use the same order of size. */
export const MAX_PICTURE_BYTES = 10 * 1024 * 1024

const fail = (output: string): MapToolResult => ({ output, isError: true })

/** The picture format from the first bytes; null for anything the map cannot show. */
export function sniffPictureExt(base64: string): 'png' | 'jpg' | 'gif' | null {
  let head: string
  try {
    head = atob(base64.slice(0, 12))
  } catch {
    return null
  }
  if (head.startsWith('\x89PNG')) return 'png'
  if (head.startsWith('GIF8')) return 'gif'
  if (head.charCodeAt(0) === 0xff && head.charCodeAt(1) === 0xd8) return 'jpg'
  return null
}

/** The bytes as the document keeps them, or null when they are not a picture it shows. */
export function pictureFromBase64(base64: string): PictureBytes | null {
  const ext = sniffPictureExt(base64)
  if (!ext) return null
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  } catch {
    return null
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PICTURE_BYTES) return null
  return { bytes, ext }
}

/** `image_search`: the same main-process image search the other editors use. */
export async function imageSearch(query: string, maxResults: unknown): Promise<MapToolResult> {
  const r = await window.mindmapApi.imageSearch(query, Number(maxResults) || 8)
  // a backend failure must not read as an empty gallery: the model would make up choices
  if (r.method === 'error') {
    return fail(
      `image search failed (service error, not an empty result — you may retry): ${r.error ?? 'unknown error'}`,
    )
  }
  const lines = r.images.map(
    (image, index) =>
      `${index + 1}. ${image.title || '(untitled)'} [${image.width ?? '?'}x${image.height ?? '?'}]\n   ${image.imageUrl}`,
  )
  return {
    output: lines.join('\n') || '(no images)',
    mutated: false,
    detail: { query, count: r.images.length },
  }
}

/** Downloads one address (a search result or a generated file) and puts it on the topic. */
export async function attachPicture(
  host: MapAiHost,
  input: { sheet?: unknown; topicId?: unknown },
  url: string,
  turn: MapTurn | null,
  signal?: AbortSignal,
): Promise<MapToolResult> {
  // the map must be still while the download runs: the edit is worked out after it
  host.flush()
  const fetched = await window.mindmapApi.fetchImage(url)
  if (signal?.aborted) return fail('stopped by the user; the picture was not inserted')
  if (!fetched) {
    return fail(
      'the image could not be downloaded; the address may have expired — search again or try another one',
    )
  }
  const picture = pictureFromBase64(fetched.base64)
  if (!picture) {
    return fail(
      'unsupported image format (only png/jpg/gif can be saved in the map) — pick another',
    )
  }
  return setTopicImage(host, input, picture, turn)
}

/** `generate_image`: one AI illustration, put on the topic by the tool itself. */
export async function generateImage(
  host: MapAiHost,
  input: { sheet?: unknown; topicId?: unknown; prompt?: unknown; aspectRatio?: unknown },
  turn: MapTurn | null,
  signal?: AbortSignal,
): Promise<MapToolResult> {
  const prompt = String(input.prompt ?? '').trim()
  if (!prompt) return fail('prompt must not be empty')
  const aspectRatio = String(input.aspectRatio ?? '').trim()
  const generated = await window.mindmapApi.generateImage({
    prompt,
    ...(aspectRatio ? { aspectRatio } : {}),
  })
  if (signal?.aborted) return fail('stopped by the user; the picture was not inserted')
  if (!generated.url) return fail(generated.error ?? 'image generation failed')
  return attachPicture(host, input, generated.url, turn, signal)
}
