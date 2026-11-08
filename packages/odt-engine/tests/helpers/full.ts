/**
 * Cross-layer runs: with `ODT_FULL_REGISTRY=1` every layer's tests use the
 * full registry (text → tables → objects → pages, as the public API does)
 * and the full save order, so one layer's tests also exercise the others.
 *
 *   ODT_FULL_REGISTRY=1 npm run test -w @genoffice/odt-engine
 */
import type { ParsedDocFull } from '@genoffice/docx-engine'
import { odtRegistry } from '../../src/assemble/registry'
import {
  type BridgeMap,
  type ConversionRegistry,
  type OdtDocument,
  OoxmlToOdfContext,
  applyTextPatches,
  rebuildOdtBody,
} from '../../src/core'
import { objectPackageChanges, prepareObjectWriteBack } from '../../src/objects'
import { preparePageWriteBack } from '../../src/page'
import { updateOdtStyles } from '../../src/text'

export const FULL_REGISTRY = !!process.env.ODT_FULL_REGISTRY

/** The full registry when cross-layer runs are on, else the layer's own. */
export const registryOr = (own: () => ConversionRegistry): ConversionRegistry =>
  FULL_REGISTRY ? odtRegistry() : own()

/** The public API's save steps (without re-packing). */
export async function fullWriteBack(
  doc: OdtDocument,
  bridgeMap: BridgeMap,
  parsed: ParsedDocFull,
  registry: ConversionRegistry,
  editedStylesXml: string | null,
): Promise<{ content: string; styles: string; rctx: OoxmlToOdfContext }> {
  const map = JSON.parse(JSON.stringify(bridgeMap)) as BridgeMap
  const rctx = new OoxmlToOdfContext(doc, map, parsed, registry, { editedStylesXml })
  prepareObjectWriteBack(rctx)
  const items = await preparePageWriteBack(rctx)
  rebuildOdtBody(rctx, items)
  updateOdtStyles(rctx)
  const patches = rctx.finish()
  const content = applyTextPatches(doc.contentXml, patches['content.xml'])
  const styles = applyTextPatches(doc.stylesXml ?? '', patches['styles.xml'])
  objectPackageChanges(rctx, { contentXml: content, stylesXml: styles })
  return { content, styles, rctx }
}
