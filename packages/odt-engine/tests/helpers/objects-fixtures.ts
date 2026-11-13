/**
 * Test plumbing for the objects layer (pictures, uneditable objects, notes,
 * comments): a Hancom-like fixture opened through the public API and an
 * editor-like save that takes raw `SaveBlock`s (picture replacement, new
 * pictures, note and comment lists).
 */
import {
  type Block,
  type ParsedDocFull,
  type SaveBlock,
  type SaveOptions,
  parseDocx,
  saveDocx,
} from '@seuoffice/docx-engine'
import type { ObjectsExt } from '../../src'
import { type Bridge, odtToBridge } from './bridge'
import { type BuildOdtOptions, type BuiltOdt, buildOdtPackage } from './build-odt'

/** `wp:docPr` name prefix of an editable ODF picture in the bridge docx (`odt-pic:<id>`). */
export const ODT_PICTURE_PREFIX = 'odt-pic:'
/** `wp:docPr` name prefix of a locked placeholder in the bridge docx (`odt-keep:<id>:<kind>`). */
export const ODT_KEEP_PREFIX = 'odt-keep:'

/** A second valid PNG (1x1 light grey), different bytes from `PNG_1X1`. */
export const PNG_GREY = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x78, 0xf1, 0xe2, 0x05,
  0x00, 0x05, 0x74, 0x02, 0xb9, 0xe7, 0x3f, 0x14, 0xc9, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
])

export interface ObjectsFixture {
  built: BuiltOdt
  bridge: Bridge
  ext: ObjectsExt
}

/** Builds a Hancom-like ODT and opens it with the public API. */
export async function objectsBridge(opts: BuildOdtOptions): Promise<ObjectsFixture> {
  const built = await buildOdtPackage(opts)
  const bridge = await odtToBridge(built.bytes)
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
