import { readFile, open, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { OdtNotTextError, isOdtOpenError } from '@seuoffice/odt-engine'
import { ATTACHABLE_IMAGE_EXTS } from './attachable'
import { diagramFormatOf } from './diagram'
import { callEngine } from './engine'
import { odtToText } from './odt'
import { pdfToText } from './pdf'
import { xmindToText } from './xmind'
import { readZipTextParts } from './zip-text-parts'

// The reading of an attachment is the Rust engine's (crates/file-parse,
// parse.rs): the draw.io check, images, the text decodings and redactors, the
// magic-byte checks and every reader. The host keeps the file system (reading
// the file, and copying a large zip's text parts from disk) and the three
// readers that await, which it runs before the call and hands over as `hosted`.

export type ParsedFileKind = 'text' | 'image' | 'unsupported'

export interface ParsedFile {
  ok: boolean
  text?: string
  kind: ParsedFileKind
  mime?: string
  /** why the read failed, in English: tools and the model read it as it is */
  error?: string
  /**
   * the file's container is damaged (`error` says so): a caller that shows the failure to a
   * person in their language shows its own message for it, not `error`
   */
  damaged?: true
}

/** Character budget for extractors that can stop early (xlsx today). */
export interface ParseFileOptions {
  /// Character budget for extractors that can stop early (xlsx and docx today).
  maxChars?: number
  /// Size past which a zip-based document is read for its text parts only
  /// (`WHOLE_ZIP_READ_MAX_BYTES` when absent; tests pass a small value).
  wholeZipMaxBytes?: number
}

/**
 * Up to this size a zip-based document is read whole, as it always was. A
 * larger one (a slide deck full of photos) is read for its text parts only
 * (`readZipTextParts`), so its size never decides whether it can be read.
 */
export const WHOLE_ZIP_READ_MAX_BYTES = 50 * 1024 * 1024

/** extensions that are, or may be, a zip-based document */
const ZIP_DOCUMENT_EXTS = new Set([
  'docx',
  'pptx',
  'xlsx',
  'xlsm',
  'hwpx',
  'odt',
  'epub',
  'xmind',
  // a DOCX under a .doc name and an HWPX under a .hwp name are read by content
  'doc',
  'hwp',
])

async function startsWithZipMagic(filePath: string): Promise<boolean> {
  const file = await open(filePath, 'r')
  try {
    const head = Buffer.alloc(2)
    const { bytesRead } = await file.read(head, 0, 2, 0)
    return bytesRead === 2 && head[0] === 0x50 && head[1] === 0x4b
  } finally {
    await file.close()
  }
}

/** the file's bytes, or for a large zip-based document its text parts only */
async function readDocumentBytes(
  filePath: string,
  ext: string,
  opts: ParseFileOptions,
): Promise<Buffer> {
  if (ZIP_DOCUMENT_EXTS.has(ext)) {
    const limit = opts.wholeZipMaxBytes ?? WHOLE_ZIP_READ_MAX_BYTES
    if ((await stat(filePath)).size > limit && (await startsWithZipMagic(filePath))) {
      return readZipTextParts(filePath)
    }
  }
  return readFile(filePath)
}

/** The readers that await, by extension: the host runs them before the call. */
const HOSTED_READERS: Record<string, (bytes: Uint8Array) => Promise<string>> = {
  pdf: pdfToText,
  xmind: xmindToText,
  odt: odtToText,
}

/** What a hosted reader read, or what it threw, as the engine takes it. */
async function hostedRead(ext: string, bytes: Uint8Array): Promise<unknown> {
  const reader = HOSTED_READERS[ext]
  if (!reader) return undefined
  try {
    return { text: await reader(bytes) }
  } catch (error) {
    const thrown = error instanceof Error ? error : new Error(String(error))
    const code =
      isOdtOpenError(error) && 'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined
    const mediaType = error instanceof OdtNotTextError ? error.mediaType : undefined
    return {
      error: {
        name: thrown.name,
        message: thrown.message,
        ...(code ? { code } : {}),
        ...(mediaType ? { mediaType } : {}),
      },
    }
  }
}

/** parse an attachment into plain text (or flag it as image / unsupported) */
export async function parseFileToText(
  filePath: string,
  opts: ParseFileOptions = {},
): Promise<ParsedFile> {
  const ext = extname(filePath).slice(1).toLowerCase()
  // a picture is not read, unless its name says it is a draw.io diagram
  const diagram = diagramFormatOf(filePath) !== null
  if (!diagram && ATTACHABLE_IMAGE_EXTS.has(ext)) {
    return callEngine<ParsedFile>('parseFileToText', [filePath, new Uint8Array(), opts, undefined])
  }
  let bytes: Uint8Array
  try {
    bytes = diagram ? await readFile(filePath) : await readDocumentBytes(filePath, ext, opts)
  } catch (e) {
    return { ok: false, kind: 'text', error: e instanceof Error ? e.message : String(e) }
  }
  const hosted = await hostedRead(ext, bytes)
  try {
    return callEngine<ParsedFile>('parseFileToText', [filePath, bytes, opts, hosted])
  } catch (e) {
    // one broken file never fails the request it is attached to
    return { ok: false, kind: 'text', error: e instanceof Error ? e.message : String(e) }
  }
}
