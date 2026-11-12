import { PDF_READ_CHUNK_BYTES } from '../shared/ipc'

/** Reads a granted file through the chunked IPC route: one invoke per slice
 * instead of a single multi-megabyte ArrayBuffer over IPC — a 42 MB
 * structured-clone deserialization has killed renderers before first paint
 * on Windows (genoffice#2366), while small slices arrive fine. The main-side
 * handler reports the file size with every slice, so the loop needs no
 * separate stat round trip. */
export interface PdfFileChunkApi {
  readFileChunk(
    path: string,
    start: number,
    end: number,
  ): Promise<{ data: Uint8Array; fileSize: number }>
}

export async function readFileBytes(
  api: PdfFileChunkApi,
  path: string,
  chunkBytes = PDF_READ_CHUNK_BYTES,
): Promise<Uint8Array> {
  // nothing is larger than no limit, so this read always has its bytes
  return (await readFileBytesWithin(api, path, Infinity, chunkBytes)) as Uint8Array
}

/** The same read for a caller that only wants a file of at most `maxBytes`:
 * null as soon as a slice reports a larger one, so the rest is never fetched. */
export async function readFileBytesWithin(
  api: PdfFileChunkApi,
  path: string,
  maxBytes: number,
  chunkBytes = PDF_READ_CHUNK_BYTES,
): Promise<Uint8Array | null> {
  let offset = 0
  let fileSize = Infinity
  let out: Uint8Array | null = null
  do {
    const end = Math.min(offset + chunkBytes, fileSize)
    const { data, fileSize: size } = await api.readFileChunk(path, offset, end)
    if (size > maxBytes) return null
    if (data.length === 0) break
    if (out === null) {
      // the first slice reports the whole size: allocate the result once and
      // copy every slice straight into it (three copies of the file never
      // exist at the same time - the point of the chunked route)
      if (!Number.isFinite(size) || size < 0) return data.length > maxBytes ? null : data.slice()
      out = new Uint8Array(size)
    } else if (out.length !== size) {
      // the size changed between slices (should not happen): grow once
      const grown: Uint8Array = new Uint8Array(size)
      grown.set(out.subarray(0, offset), 0)
      out = grown
    }
    out!.set(data, offset)
    offset += data.length
    fileSize = size
  } while (offset < fileSize)
  return out ? out.subarray(0, offset) : new Uint8Array(0)
}
