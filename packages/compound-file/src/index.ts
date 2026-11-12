import * as CFB from 'cfb'

import {
  CompoundFileError,
  assertCompoundFile,
  isCompoundFileError,
  type Ole2FailureCode,
} from './validate'

export {
  CompoundFileError,
  MAX_DIRECTORY_ENTRIES,
  MAX_STORAGE_DEPTH,
  OLE2_HEADER_BYTES,
  OLE2_MAGIC,
  assertCompoundFile,
  hasOle2Signature,
  isCompoundFileError,
  type Ole2FailureCode,
} from './validate'

/**
 * The OLE2/CFB container opener shared by the legacy Office importers (the
 * .doc reader in @genoffice/doc2docx, the .ppt reader in @genoffice/ppt2pptx,
 * and any .xls reader that comes along), and the gate every other reader of a
 * compound file passes first (the HWP 5 readers, the attachment parsers).
 *
 * The gate (`assertCompoundFile`, see validate.ts) checks the signature, the
 * header, the sector tables and the directory before cfb parses anything. The
 * opener then caps the input and every stream, and hands back owned stream
 * bytes so a later mutation of the container cannot change a parsed part.
 * Callers layer their own format checks (WordDocument / PowerPoint Document /
 * Workbook) and map the failure codes onto their own error model.
 */

/** The size caps of the shared opener; each legacy importer picks its own. */
export interface Ole2Limits {
  /** whole input file */
  maxBytes: number
  /** one decompressed stream */
  maxStreamBytes: number
}

/** The top-level streams of an OLE2 container (OLE2 calls them storages/streams). */
export interface Ole2Streams {
  /** raw bytes of a stream by name (e.g. "WordDocument"), or undefined when absent */
  stream(name: string): Uint8Array | undefined
  /** names of the streams that carry document data (producer markers filtered out) */
  streams(): string[]
}

export type Ole2OpenResult =
  | { readonly ok: true; readonly container: Ole2Streams }
  | { readonly ok: false; readonly code: Ole2FailureCode; readonly detail: string }

function failure(code: Ole2FailureCode, detail: string): Ole2OpenResult {
  return { ok: false, code, detail }
}

/** the stream's own bytes, so a later mutation of the CFB container cannot change a parsed part */
function toOwnedBytes(content: unknown): Uint8Array {
  // any view, not `instanceof Uint8Array`: cfb hands a Buffer back for a Buffer, and under
  // jsdom a Node Buffer is not an instance of the page's Uint8Array
  if (ArrayBuffer.isView(content)) {
    return new Uint8Array(content.buffer, content.byteOffset, content.byteLength).slice()
  }
  if (Array.isArray(content)) return Uint8Array.from(content as number[])
  // cfb stores Array<number> or a byte view for stream content, and nothing for an empty stream
  return new Uint8Array(0)
}

/** stream name relative to the root entry ("Root Entry/WordDocument" -> "WordDocument") */
function streamNameOf(path: string, fallback: string): string {
  const relative = path.startsWith('Root Entry/')
    ? path.slice('Root Entry/'.length)
    : path.replace(/^\/+/, '')
  return relative || fallback
}

/** cfb seeds every new container with this producer marker; it carries no document data */
const cfbProducerStream = (name: string): boolean => name.startsWith('\u0001')

/**
 * The cfb container of a compound file, for a reader that works on the
 * container itself (finds entries, rewrites streams). The bytes pass the gate
 * first; a CompoundFileError says why they did not, or that cfb could not read
 * what passed.
 */
export function readCompoundFile(bytes: Uint8Array): CFB.CFB$Container {
  assertCompoundFile(bytes)
  // cfb slices a Buffer into views; any other array it copies into arrays of
  // numbers, at several times the size the gate's copy budget counts on
  const input =
    typeof Buffer === 'undefined' || Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  try {
    // 'buffer' input is parsed directly (cfb would otherwise treat a Uint8Array as a base64 string)
    return CFB.read(input, { type: 'buffer' })
  } catch (error) {
    throw new CompoundFileError(
      'corrupt',
      `the OLE2 container cannot be read (${error instanceof Error ? error.message : String(error)})`,
    )
  }
}

/**
 * Open an OLE2 compound file and expose its document streams.
 *
 * Caps the input, passes it through the gate, caps every stored stream, and
 * skips cfb's producer-marker streams. A file that passes is a real compound
 * document, not an OOXML part renamed to a legacy extension.
 */
export function openOle2Container(bytes: Uint8Array, limits: Ole2Limits): Ole2OpenResult {
  if (bytes.length === 0) return failure('not_cfb', 'the file is empty')
  if (bytes.length > limits.maxBytes) {
    return failure(
      'limits_exceeded',
      `the file is ${bytes.length} bytes, over the ${limits.maxBytes}-byte limit`,
    )
  }

  let container: CFB.CFB$Container
  try {
    container = readCompoundFile(bytes)
  } catch (error) {
    if (isCompoundFileError(error)) return failure(error.code, error.detail)
    throw error
  }

  const streams = new Map<string, Uint8Array>()
  const paths = container.FullPaths ?? []
  for (let index = 0; index < paths.length; index++) {
    const entry = container.FileIndex[index]
    if (!entry || entry.type !== 2) continue
    const name = streamNameOf(paths[index] ?? '', entry.name)
    if (!name || cfbProducerStream(name) || streams.has(name)) continue
    const content = toOwnedBytes(entry.content)
    if (content.length > limits.maxStreamBytes) {
      return failure(
        'limits_exceeded',
        `the ${name} stream is ${content.length} bytes, over the ${limits.maxStreamBytes}-byte limit`,
      )
    }
    streams.set(name, content)
  }

  return {
    ok: true,
    container: {
      stream: (name) => streams.get(name),
      streams: () => [...streams.keys()].sort(),
    },
  }
}
