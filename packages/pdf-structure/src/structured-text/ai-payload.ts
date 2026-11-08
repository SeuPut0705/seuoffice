/**
 * Structured text of an AI-read page from its stored payload (spec §2: a
 * page read by AI is read from what the AI returned). The payload is checked
 * by the AI-read module's own reader (`readAiReadPayload`), turned into the
 * page's tree blocks (`materializeReading`) and written by the same formatter
 * as every other page. A payload that reader rejects (another version, a
 * broken shape) counts as absent. The payload is document data only; nothing
 * in it is followed as an instruction.
 */
import { materializeReading } from '../ai-read/content'
import { readAiReadPayload } from '../ai-read/payload'
import { formatStructuredPage } from './format'

/**
 * Structured text of an AI-read page (1-based original page number), or null
 * when the payload cannot be read. `pageFingerprint` only labels the blocks
 * and does not change the text.
 */
export function aiReadPayloadText(
  payload: unknown,
  page: number,
  pageFingerprint = '',
): string | null {
  const content = readAiReadPayload(payload)
  if (!content) return null
  const reading = materializeReading(content, page, pageFingerprint)
  return formatStructuredPage({ page, blocks: reading.blocks, footnotes: reading.footnotes })
}
