/**
 * The open deck as a skill template (spec 5.6): its bytes as edited now, and
 * whether it carries any "withheld from the model" mark. The bytes come from
 * the engine's own writer, like the recovery copy: nothing is written to disk
 * and the deck's unsaved state is left as it is.
 */
import type { IpcMain } from 'electron'
import { savePptx, type OpenedPptx } from '@seuoffice/pptx-engine'
import { holdsRedactionMark } from '../shared/redaction-marks'

/** Any redaction mark anywhere in the deck's slides (see holdsRedactionMark). */
export function deckHasRedaction(opened: Pick<OpenedPptx, 'deck'>): boolean {
  return holdsRedactionMark(opened.deck.slides)
}

/** The deck's bytes and its redaction answer, or null when this view has no deck */
export async function deckTemplateBytes(
  opened: OpenedPptx | undefined,
): Promise<{ bytes: Uint8Array; redacted: boolean } | null> {
  if (!opened) return null
  return { bytes: await savePptx(opened), redacted: deckHasRedaction(opened) }
}

/**
 * Registers `slides:template-bytes`. Called once, with the editor's other channels. `track`
 * runs the serialization as an in-flight write of the view's deck (refused while an AI run's
 * unaccepted edits are in it; a refusal answers null).
 */
export function registerSlidesTemplateBytesIpc(
  ipc: Pick<IpcMain, 'handle'>,
  openedOf: (webContentsId: number) => OpenedPptx | undefined,
  track: <T>(webContentsId: number, write: () => Promise<T>) => Promise<T>,
): void {
  ipc.handle('slides:template-bytes', async (e) => {
    try {
      return await track(e.sender.id, () => deckTemplateBytes(openedOf(e.sender.id)))
    } catch {
      return null
    }
  })
}
