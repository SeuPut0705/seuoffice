import { hwpToText } from '@seuoffice/file-parse/hwp'
import { convertHwpToDocx, HwpConvertError } from '@seuoffice/hwp2docx'
import { rhwpWasmPath } from '../resources'
import { CliError, EXIT } from '../result'

/** Characters `hwp read` returns unless told otherwise. */
export const HWP_PREVIEW_CHARS = 20_000

/**
 * The text of an HWP / HWPX document: paragraphs as lines, data tables as rows
 * with cells joined by " | " (the reader is the one the app uses for
 * attachments and search).
 */
export async function hwpText(bytes: Uint8Array): Promise<string> {
  return hwpToText(bytes)
}

/** What `info` says about an HWP / HWPX document. */
export async function hwpInfo(bytes: Uint8Array): Promise<{ chars: number; lines: number }> {
  const text = await hwpText(bytes)
  return { chars: text.length, lines: text ? text.split('\n').length : 0 }
}

/** .hwp/.hwpx → .docx through the local import filter (routed by content, not extension). */
export async function convertHwp(input: Uint8Array): Promise<{
  bytes: Uint8Array
  detail: Record<string, unknown>
}> {
  process.env.SEUOFFICE_RHWP_WASM ??= rhwpWasmPath()
  try {
    const result = await convertHwpToDocx(input)
    return {
      bytes: result.docx,
      detail: {
        blocks: result.blocks,
        dropped: result.dropped,
        ...(result.via ? { via: result.via } : {}),
      },
    }
  } catch (err) {
    if (err instanceof HwpConvertError) {
      throw new CliError(EXIT.conversion, err.message, { reason: err.code })
    }
    throw err
  }
}
