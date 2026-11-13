/**
 * `@seuoffice/file-parse` as `apps/hwp/src/main/attachments-ipc.ts` sees it:
 * the real attachable list and the real `diagramPictureExtOf`, with the two
 * parsers answering from the case's `hosts.d2.hwp` as `FakeEngine` in
 * crates/shell-ipc/d2/src/hwp/mod.rs does (`parse_file_to_text`,
 * `checked_hwp_bytes`), one host-log line per call.
 */
import { readFileSync } from 'node:fs'
import { world } from './common.ts'

export {
  ATTACHABLE_EXTS,
  ATTACHABLE_IMAGE_EXTS,
  ATTACHABLE_IMAGE_MAX_BYTES,
  ATTACHABLE_MAX_BYTES,
  attachableMaxBytes,
  diagramPictureExtOfName,
} from '../../../../../packages/file-parse/src/attachable.ts'
export { diagramPictureExtOf } from '../../../../../packages/file-parse/src/diagram.ts'

interface Parsed {
  ok: boolean
  kind: 'text' | 'image' | 'unsupported'
  text?: string
  error?: string
  damaged?: boolean
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export async function parseFileToText(filePath: string): Promise<Parsed> {
  const w = world()
  w.log.push(['parseFileToText', filePath])
  const answer = w.answers.next('parse_file_to_text') as Record<string, unknown> | undefined
  if (answer === undefined) {
    return { ok: true, kind: 'text', text: readFileSync(filePath).toString('utf8') }
  }
  return {
    ok: answer.ok === true,
    kind: answer.kind === 'image' || answer.kind === 'unsupported' ? answer.kind : 'text',
    text: str(answer.text),
    error: str(answer.error),
    damaged: answer.damaged === true,
  }
}

export async function checkedHwpBytes(bytes: Uint8Array, ext: string): Promise<Uint8Array> {
  const w = world()
  w.log.push(['checkedHwpBytes', ext])
  const answer = w.answers.next('checked_hwp_bytes')
  if (typeof answer === 'string') throw new Error(answer)
  return bytes
}
