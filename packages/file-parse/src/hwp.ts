import { createRequire } from 'node:module'
import { join } from 'node:path'
import { callEngine } from './engine'

/**
 * Hangul word processor documents (HWP 5, HWPX, some HWP 3) to text, read by the
 * rhwp engine compiled into the Rust readers. A zip passes the zip gate and a
 * Hangul 5 file the compound-file gate before the engine reads it.
 */

/**
 * Where rhwp's own wasm build is, for the callers that run rhwp in JavaScript
 * (the HWP export of the Word editor, the command line). A dev checkout and the tests have it in
 * node_modules; the packaged app has no node_modules and ships it under
 * Resources/wasm (apps/shell/electron-builder.cjs), like the PDF engines.
 */
export function rhwpWasmPath(): string {
  const fromEnv = process.env.SEUOFFICE_RHWP_WASM
  if (fromEnv) return fromEnv
  try {
    return createRequire(import.meta.url).resolve('@rhwp/core/rhwp_bg.wasm')
  } catch {
    /* fall through */
  }
  const resources = (process as { resourcesPath?: string }).resourcesPath
  if (resources) return join(resources, 'wasm', 'rhwp_bg.wasm')
  throw new Error('rhwp_bg.wasm not found (set SEUOFFICE_RHWP_WASM)')
}

/** One memo as the engine lists it: where its anchor sits in the body, and the note itself. */
export interface HwpMemo {
  id?: number
  index?: number
  author?: string
  date?: string | null
  text?: string
  place?: string
  sectionIndex?: number | null
  paraIndex?: number | null
  startCharIdx?: number | null
  endCharIdx?: number | null
  path?: Array<{
    type: string
    controlIndex?: number
    cellIndex?: number
    paraIndex?: number
  }> | null
}

/**
 * The memos of an HWP / HWPX document, as the engine holds them. Records in the bytes
 * the engine does not model are not listed; a caller checking a save counts those
 * separately from the raw file.
 */
export async function hwpMemosOf(bytes: Uint8Array): Promise<HwpMemo[]> {
  return callEngine<HwpMemo[]>('hwpMemosOf', [bytes])
}

/**
 * The bytes of an `.hwp` / `.hwpx` file, checked as parseFileToText checks them before the
 * engine gets them: the content must be what the name says (an HWPX is a zip; an HWP is
 * Hangul 5, Hangul 3, or an HWPX under the old name), a zip must pass the zip gate and a
 * Hangul 5 file the compound-file gate.
 * For a caller that opens the document with the engine itself, such as the HWP editor
 * reading the formatting of an attached document. Throws when a check fails.
 */
export async function checkedHwpBytes(bytes: Uint8Array, ext: string): Promise<Uint8Array> {
  callEngine<undefined>('checkedHwpBytes', [bytes, ext])
  return bytes
}

/** The text of an HWP / HWPX document: paragraphs as lines, data tables as " | " rows. */
export async function hwpToText(bytes: Uint8Array): Promise<string> {
  return callEngine<string>('hwpToText', [bytes])
}
