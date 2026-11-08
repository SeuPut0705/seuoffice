/**
 * The open deck as a skill template (spec 5.6): its bytes as edited now, and
 * whether it carries any "withheld from the model" mark. The bytes come from
 * the engine's own writer, like the recovery copy: nothing is written to disk
 * and the deck's unsaved state is left as it is.
 */
import type { IpcMain } from 'electron'
import { savePptx, type OpenedPptx } from '@genoffice/pptx-engine'

/**
 * Any redaction mark anywhere in the deck's slides: a run's or an element's
 * `redact` label, tables and groups included. A deep walk over the model, so a
 * mark in a place the AI view does not list still counts (fail closed).
 */
export function deckHasRedaction(opened: Pick<OpenedPptx, 'deck'>): boolean {
  const seen = new WeakSet<object>()
  const stack: unknown[] = [opened.deck.slides]
  while (stack.length > 0) {
    const value = stack.pop()
    if (!value || typeof value !== 'object') continue
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) continue
    if (seen.has(value)) continue
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item)
      continue
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'redact' && typeof child === 'string' && child !== '') return true
      if (child && typeof child === 'object') stack.push(child)
    }
  }
  return false
}

/** The deck's bytes and its redaction answer, or null when this view has no deck */
export async function deckTemplateBytes(
  opened: OpenedPptx | undefined,
): Promise<{ bytes: Uint8Array; redacted: boolean } | null> {
  if (!opened) return null
  return { bytes: await savePptx(opened), redacted: deckHasRedaction(opened) }
}

/** Registers `slides:template-bytes`. Called once, with the editor's other channels. */
export function registerSlidesTemplateBytesIpc(
  ipc: Pick<IpcMain, 'handle'>,
  openedOf: (webContentsId: number) => OpenedPptx | undefined,
): void {
  ipc.handle('slides:template-bytes', async (e) => {
    try {
      return await deckTemplateBytes(openedOf(e.sender.id))
    } catch {
      return null
    }
  })
}
