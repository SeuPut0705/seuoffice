import { openXmind, sheetsToOutline } from '@genoffice/xmind-engine'

/**
 * Mind map to the outline text every reader of a map shares (the engine's one
 * map-to-text function). The engine runs the zip gate before it inflates
 * anything. Throws for a file that does not open: legacy format, encrypted,
 * unreadable, or refused by the gate.
 */
export async function xmindToText(bytes: Uint8Array): Promise<string> {
  const opened = await openXmind(bytes)
  if (opened.status !== 'ok') {
    throw new Error(`Cannot read mind map (${opened.status}): ${opened.detail}`)
  }
  return sheetsToOutline(opened.document.sheets)
}
