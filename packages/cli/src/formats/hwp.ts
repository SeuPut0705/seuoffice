import { hwpToText } from '@genoffice/file-parse/hwp'
import { rhwpWasmPath } from '../resources'

/** Characters `hwp read` returns unless told otherwise. */
export const HWP_PREVIEW_CHARS = 20_000

/**
 * The text of an HWP / HWPX document: paragraphs as lines, data tables as rows
 * with cells joined by " | " (the reader is the one the app uses for
 * attachments and search).
 */
export async function hwpText(bytes: Uint8Array): Promise<string> {
  // the reader looks in node_modules first; a packaged CLI has none, so it is told
  // where the engine sits beside this bundle (src/resources.ts)
  process.env.GENOFFICE_RHWP_WASM ??= rhwpWasmPath()
  return hwpToText(bytes)
}

/** What `info` says about an HWP / HWPX document. */
export async function hwpInfo(bytes: Uint8Array): Promise<{ chars: number; lines: number }> {
  const text = await hwpText(bytes)
  return { chars: text.length, lines: text ? text.split('\n').length : 0 }
}
