/**
 * `@seuoffice/drawio-model` as the real `file-parse/src/diagram.ts` sees it:
 * the real package, with `extractDiagramXml` answering from the case's
 * `hosts.d2.hwp.diagram_picture_has_no_original` (`FakeEngine`), one host-log
 * line per call.
 */
import { world } from './common.ts'

export * from '@seuoffice/drawio-model'

export function extractDiagramXml(
  fileName: string,
  _bytes: Uint8Array,
  _codec: unknown,
):
  | { ok: true; format: 'drawio.png'; xml: string; bom: boolean }
  | {
      ok: false
      reason: 'no_original'
      message: string
    } {
  const w = world()
  w.log.push(['extractDiagramXml', fileName])
  if (w.answers.next('diagram_picture_has_no_original') === true) {
    return { ok: false, reason: 'no_original', message: 'no diagram inside' }
  }
  return { ok: true, format: 'drawio.png', xml: '', bom: false }
}
