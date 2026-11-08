/**
 * Test plumbing for the objects layer (pictures, uneditable objects, notes,
 * comments): the registry in the assembling order (text, then objects), an
 * editor-like save that takes raw `SaveBlock`s (picture replacement, new
 * pictures, note and comment lists), and a write-back that runs the objects
 * layer's pre- and post-steps and applies the package changes to the manifest.
 */
import {
  type Block,
  type ParsedDocFull,
  type SaveBlock,
  type SaveOptions,
  parseDocx,
  saveDocx,
} from '@genoffice/docx-engine'
import {
  ConversionRegistry,
  OoxmlToOdfContext,
  applyTextPatches,
  readDocxPart,
  rebuildOdtBody,
} from '../../src/core'
import {
  type ObjectsExt,
  type OdtPackageChanges,
  objectPackageChanges,
  patchManifestXml,
  prepareObjectWriteBack,
  registerObjectConverters,
} from '../../src/objects'
import { registerTextConverters, updateOdtStyles } from '../../src/text'
import { type Bridge, odtToBridge } from './bridge'
import { type BuildOdtOptions, type BuiltOdt, buildOdtPackage } from './build-odt'
import { FULL_REGISTRY, fullWriteBack, registryOr } from './full'

/** A second valid PNG (1x1 light grey), different bytes from `PNG_1X1`. */
export const PNG_GREY = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x78, 0xf1, 0xe2, 0x05,
  0x00, 0x05, 0x74, 0x02, 0xb9, 0xe7, 0x3f, 0x14, 0xc9, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
])

/** Text then objects, as the assembling task registers them (tables are not on this branch). */
export function objectsRegistry(): ConversionRegistry {
  return registryOr(() =>
    registerObjectConverters(registerTextConverters(new ConversionRegistry())),
  )
}

export interface ObjectsFixture {
  built: BuiltOdt
  bridge: Bridge
  ext: ObjectsExt
}

/** Builds a Hancom-like ODT and opens it through text + objects. */
export async function objectsBridge(opts: BuildOdtOptions): Promise<ObjectsFixture> {
  const built = await buildOdtPackage(opts)
  const bridge = await odtToBridge(built.bytes, objectsRegistry())
  const ext = (bridge.map.ext.objects ?? {
    version: 1,
    placeholders: [],
    pictures: [],
    comments: [],
    notes: [],
  }) as unknown as ObjectsExt
  return { built, bridge, ext }
}

/** The visible blocks of a docx with its full parse. */
export async function visibleBlocks(docx: Uint8Array): Promise<{
  parsed: ParsedDocFull
  blocks: Block[]
}> {
  const parsed = (await parseDocx(docx)) as ParsedDocFull
  return { parsed, blocks: parsed.blocks.filter((b) => !b.hidden) }
}

/** Saves the bridge docx from raw save blocks, like the editor does. */
export async function saveBlocks(
  docx: Uint8Array,
  build: (blocks: Block[], parsed: ParsedDocFull) => SaveBlock[],
  options: SaveOptions | ((parsed: ParsedDocFull) => SaveOptions) = {},
): Promise<Uint8Array> {
  const { parsed, blocks } = await visibleBlocks(docx)
  const opts = typeof options === 'function' ? options(parsed) : options
  return saveDocx(parsed, build(blocks, parsed), opts)
}

/** `{ kind: 'original' }` for every block except those `edit` replaces (null = delete). */
export function keepAllBut(
  blocks: Block[],
  edit: Record<number, SaveBlock | SaveBlock[] | null>,
): SaveBlock[] {
  const out: SaveBlock[] = []
  blocks.forEach((b, i) => {
    if (!(i in edit)) out.push({ kind: 'original', docxIndex: b.docxIndex as number })
    else {
      const e = edit[i]
      if (e === null) return
      out.push(...(Array.isArray(e) ? e : [e]))
    }
  })
  return out
}

export interface ObjectsWriteBack {
  content: string
  styles: string
  manifest: string
  changes: OdtPackageChanges
  rctx: OoxmlToOdfContext
}

/** Writes an edited docx back with the objects layer's pre- and post-steps. */
export async function writeBackObjects(
  fixture: ObjectsFixture,
  edited: Uint8Array,
): Promise<ObjectsWriteBack> {
  const { bridge, built } = fixture
  const parsed = await parseDocx(edited)
  const editedStylesXml = await readDocxPart(edited, 'word/styles.xml')
  if (FULL_REGISTRY) {
    const full = await fullWriteBack(
      bridge.doc,
      bridge.map,
      parsed,
      bridge.registry,
      editedStylesXml,
    )
    const changes = objectPackageChanges(full.rctx, {
      contentXml: full.content,
      stylesXml: full.styles,
    })
    return { ...full, manifest: patchManifestXml(built.manifestXml, changes), changes }
  }
  // the map crosses IPC: write back from a JSON copy, as the app does
  const map = JSON.parse(JSON.stringify(bridge.map)) as typeof bridge.map
  const rctx = new OoxmlToOdfContext(bridge.doc, map, parsed, bridge.registry, {
    editedStylesXml,
  })
  prepareObjectWriteBack(rctx)
  rebuildOdtBody(rctx)
  updateOdtStyles(rctx)
  const patches = rctx.finish()
  const content = applyTextPatches(bridge.doc.contentXml, patches['content.xml'])
  const styles = applyTextPatches(bridge.doc.stylesXml ?? '', patches['styles.xml'])
  const changes = objectPackageChanges(rctx, { contentXml: content, stylesXml: styles })
  return {
    content,
    styles,
    manifest: patchManifestXml(built.manifestXml, changes),
    changes,
    rctx,
  }
}

/** Base64 of bytes (tests only). */
export const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

/** The `<w:drawing>` fragment of a run or block XML. */
export function drawingOf(xml: string): string {
  const m = /<w:drawing>[\s\S]*?<\/w:drawing>/.exec(xml)
  if (!m) throw new Error('no drawing')
  return m[0]
}

/** Sets `wp:extent` and `a:ext` of a drawing fragment to new EMU sizes. */
export function resizeDrawing(xml: string, cx: number, cy: number): string {
  return xml
    .replace(/<wp:extent cx="\d+" cy="\d+"\/>/, `<wp:extent cx="${cx}" cy="${cy}"/>`)
    .replace(/<a:ext cx="\d+" cy="\d+"\/>/, `<a:ext cx="${cx}" cy="${cy}"/>`)
}
