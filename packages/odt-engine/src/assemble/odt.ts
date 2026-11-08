/**
 * Opening a received ODT for the Word editor and saving the edited docx back
 * into it.
 *
 * Save order (each layer documents its own step):
 *   prepareObjectWriteBack → preparePageWriteBack → rebuildOdtBody →
 *   updateOdtStyles → finish → applyTextPatches → objectPackageChanges →
 *   patchManifestXml → re-pack.
 * The bridge map is deep-copied first: the page and objects pre-steps edit
 * the map they are given.
 */
import { parseDocx } from '@genoffice/docx-engine'
import {
  type BridgeMap,
  type JsonValue,
  OdfToOoxmlContext,
  OoxmlToOdfContext,
  applyTextPatches,
} from '../core/convert'
import { buildBridgeDocx, readDocxPart } from '../core/docx-package'
import { convertOdtBody, rebuildOdtBody } from '../core/flow'
import { type OdtDocument, openOdt } from '../core/open'
import { objectPackageChanges, patchManifestXml, prepareObjectWriteBack } from '../objects'
import { convertOdtPage, preparePageWriteBack } from '../page'
import { convertOdtStyles, updateOdtStyles } from '../text'
import {
  type BridgeCoreProps,
  coreXmlFor,
  personalInfoRemoved,
  readMetaPeople,
  scrubMetaXml,
} from './meta'
import { odtRegistry } from './registry'
import { type ConversionReport, odtToDocxReport } from './report'
import { type ZipEntryInput, writeZip } from './zip'

/** The assembly's own slot in the bridge map. */
export const ASSEMBLE_EXT_KEY = 'assemble'

interface AssembleExt {
  version: 1
  /** people fields the bridge docx's core.xml shows, or null when it has none */
  core: BridgeCoreProps | null
}

export interface OdtToDocxResult {
  /** the bridge docx the Word editor opens */
  docxBytes: Uint8Array
  /** the bridge map (plain JSON): pass it back to `saveOdt` */
  bridge: BridgeMap
  /** what changes if this ODT is saved as docx */
  report: ConversionReport
}

/** Converts a received ODT for the Word editor. Throws `OdtOpenError` (encrypted, not an ODT, corrupt). */
export async function odtToDocx(odtBytes: Uint8Array): Promise<OdtToDocxResult> {
  const doc = await openOdt(odtBytes)
  const ctx = new OdfToOoxmlContext(doc, odtRegistry())
  convertOdtStyles(ctx)
  convertOdtBody(ctx)
  convertOdtPage(ctx)
  const people = readMetaPeople(doc)
  const core = coreXmlFor(doc, people)
  if (core !== null) {
    ctx.docx.parts.push({
      path: 'docProps/core.xml',
      data: core,
      contentType: 'application/vnd.openxmlformats-package.core-properties+xml',
    })
  }
  const ext: AssembleExt = { version: 1, core: core !== null ? people : null }
  ctx.map.ext[ASSEMBLE_EXT_KEY] = ext as unknown as JsonValue
  const docxBytes = await buildBridgeDocx(ctx)
  return { docxBytes, bridge: ctx.map, report: odtToDocxReport(doc, ctx.map) }
}

export interface SaveOdtInput {
  /** the ODT as received (and opened with `odtToDocx`) */
  originalOdt: Uint8Array
  /** the bridge map `odtToDocx` returned (it is not modified) */
  bridge: BridgeMap
  /** the docx the editor saved */
  editedDocx: Uint8Array
}

const encoder = new TextEncoder()

/**
 * Writes the edited docx back into the received ODT: only what changed is
 * rewritten, every untouched part keeps its bytes. With nothing changed the
 * original bytes come back as they are.
 */
export async function saveOdt(input: SaveOdtInput): Promise<Uint8Array> {
  const { originalOdt, editedDocx } = input
  const doc = await openOdt(originalOdt)
  const map = JSON.parse(JSON.stringify(input.bridge)) as BridgeMap
  const edited = await parseDocx(editedDocx)
  const editedStylesXml = await readDocxPart(editedDocx, 'word/styles.xml')
  const rctx = new OoxmlToOdfContext(doc, map, edited, odtRegistry(), { editedStylesXml })
  prepareObjectWriteBack(rctx)
  const items = await preparePageWriteBack(rctx)
  rebuildOdtBody(rctx, items)
  updateOdtStyles(rctx)
  const patches = rctx.finish()
  const contentXml = applyTextPatches(doc.contentXml, patches['content.xml'])
  const stylesXml =
    doc.stylesXml === null ? null : applyTextPatches(doc.stylesXml, patches['styles.xml'])
  const changes = objectPackageChanges(rctx, { contentXml, stylesXml })

  const replaced = new Map<string, string>()
  if (contentXml !== doc.contentXml) replaced.set('content.xml', contentXml)
  if (stylesXml !== null && stylesXml !== doc.stylesXml) replaced.set('styles.xml', stylesXml)
  const manifestXml = doc.pkg.text('META-INF/manifest.xml')
  if (manifestXml !== undefined) {
    const patched = patchManifestXml(manifestXml, changes)
    if (patched !== manifestXml) replaced.set('META-INF/manifest.xml', patched)
  }
  if (doc.metaXml !== null) {
    const ext = map.ext[ASSEMBLE_EXT_KEY] as unknown as AssembleExt | undefined
    const coreXml = await readDocxPart(editedDocx, 'docProps/core.xml')
    if (personalInfoRemoved(ext?.core ?? null, coreXml, edited.removePersonalInfo)) {
      const scrubbed = scrubMetaXml(doc.metaXml)
      if (scrubbed !== doc.metaXml) replaced.set('meta.xml', scrubbed)
    }
  }
  if (!replaced.size && !changes.add.length && !changes.remove.length) return originalOdt
  return repackOdt(doc, replaced, changes)
}

/**
 * Re-packs the package: `mimetype` first and stored, the other entries in
 * their original order (untouched ones from their original compressed data),
 * removed entries left out, new entries at the end.
 */
export async function repackOdt(
  doc: OdtDocument,
  replaced: ReadonlyMap<string, string | Uint8Array>,
  changes: { add: ReadonlyArray<{ path: string; data: Uint8Array }>; remove: readonly string[] },
): Promise<Uint8Array> {
  const removed = (name: string) =>
    changes.remove.some((r) => {
      const base = r.replace(/\/$/, '')
      return name === r || name === base || name.startsWith(`${base}/`)
    })
  const inputs: ZipEntryInput[] = []
  const mimetype = doc.pkg.get('mimetype')
  if (mimetype) {
    inputs.push(
      mimetype.method === 0
        ? { kind: 'original', entry: mimetype }
        : {
            kind: 'data',
            name: 'mimetype',
            data: mimetype.bytes,
            store: true,
            dosDateTime: mimetype.dosDateTime,
          },
    )
  }
  const seen = new Set<string>(['mimetype'])
  for (const entry of doc.pkg.entries) {
    if (seen.has(entry.name)) continue
    seen.add(entry.name)
    if (removed(entry.name)) continue
    const now = replaced.get(entry.name)
    if (now === undefined) inputs.push({ kind: 'original', entry })
    else
      inputs.push({
        kind: 'data',
        name: entry.name,
        data: typeof now === 'string' ? encoder.encode(now) : now,
        dosDateTime: entry.dosDateTime,
      })
  }
  for (const a of changes.add) {
    if (seen.has(a.path)) continue
    seen.add(a.path)
    inputs.push({ kind: 'data', name: a.path, data: a.data })
  }
  return writeZip(inputs)
}
