/**
 * Test plumbing for the text layer: ODT → bridge docx, the editor's way of
 * saving an edited paragraph (rawPPr reuse, `saveDocx`), and the write-back
 * into the original ODT strings.
 */
import {
  type Block,
  type GeneratedBlock,
  type ParsedDocFull,
  type SaveBlock,
  type SaveOptions,
  mergePPrFormat,
  parseDocx,
  saveDocx,
} from '@genoffice/docx-engine'
import {
  type BridgeMap,
  ConversionRegistry,
  OdfToOoxmlContext,
  OoxmlToOdfContext,
  type OdtDocument,
  applyTextPatches,
  buildBridgeDocx,
  convertOdtBody,
  openOdt,
  readDocxPart,
  rebuildOdtBody,
} from '../../src/core'
import { convertOdtPage } from '../../src/page'
import { convertOdtStyles, registerTextConverters, updateOdtStyles } from '../../src/text'
import { FULL_REGISTRY, fullWriteBack, registryOr } from './full'

export interface Bridge {
  doc: OdtDocument
  ctx: OdfToOoxmlContext
  map: BridgeMap
  docx: Uint8Array
  registry: ConversionRegistry
}

export function textRegistry(): ConversionRegistry {
  return registryOr(() => registerTextConverters(new ConversionRegistry()))
}

export async function odtToBridge(
  bytes: Uint8Array,
  registry: ConversionRegistry = textRegistry(),
): Promise<Bridge> {
  const doc = await openOdt(bytes)
  const ctx = new OdfToOoxmlContext(doc, registry)
  convertOdtStyles(ctx)
  convertOdtBody(ctx)
  if (FULL_REGISTRY) convertOdtPage(ctx)
  const docx = await buildBridgeDocx(ctx)
  // the map must survive a JSON round trip (it crosses IPC)
  const map = JSON.parse(JSON.stringify(ctx.map)) as BridgeMap
  return { doc, ctx, map, docx, registry }
}

/** A generated block carrying everything the editor carries for a parsed paragraph. */
export function generatedFrom(block: Block): GeneratedBlock {
  return JSON.parse(
    JSON.stringify({
      type: block.type as GeneratedBlock['type'],
      level: block.level,
      outlineOnly: block.outlineOnly,
      styleId: block.styleId,
      list: block.list,
      format: block.format,
      bookmarks: block.bookmarks,
      hiddenBookmarks: block.hiddenBookmarks,
      runs: block.runs ?? [],
    }),
  ) as GeneratedBlock
}

/** What the editor does before saving an in-place edit: reuse or merge the original pPr. */
export function applyRawPPr(generated: GeneratedBlock, original: Block): void {
  const structureSame =
    original.type === generated.type &&
    (original.level ?? null) === (generated.level ?? null) &&
    (original.styleId ?? null) === (generated.styleId ?? null) &&
    JSON.stringify(original.list ?? null) === JSON.stringify(generated.list ?? null)
  if (original.rawPPr === undefined || !structureSame) return
  const same = JSON.stringify(original.format ?? null) === JSON.stringify(generated.format ?? null)
  generated.rawPPr = same
    ? original.rawPPr
    : mergePPrFormat(original.rawPPr, generated.format, original.format)
}

export type EditorOp =
  | { keep: number }
  | { edit: number; change: (g: GeneratedBlock) => void }
  /** a new paragraph (e.g. the second half of an Enter split): no anchor, no hidden bookmarks */
  | { insert: GeneratedBlock }
  /** a self-contained OOXML fragment the editor wrote (e.g. a changed table) */
  | { xml: string; docxIndex?: number }

/** Saves the bridge docx the way the editor would for the given operations. */
export async function editorSave(
  docx: Uint8Array,
  ops: (blocks: Block[]) => EditorOp[],
  options: SaveOptions = {},
): Promise<{ bytes: Uint8Array; parsed: ParsedDocFull }> {
  const parsed = await parseDocx(docx)
  const visible = parsed.blocks.filter((b) => !b.hidden)
  const out: SaveBlock[] = []
  for (const op of ops(visible)) {
    if ('keep' in op)
      out.push({ kind: 'original', docxIndex: visible[op.keep].docxIndex as number })
    else if ('edit' in op) {
      const original = visible[op.edit]
      const g = generatedFrom(original)
      op.change(g)
      applyRawPPr(g, original)
      out.push({ kind: 'generated', block: g, docxIndex: original.docxIndex as number })
    } else if ('xml' in op) {
      out.push({
        kind: 'xml',
        xml: op.xml,
        ...(op.docxIndex !== undefined ? { docxIndex: op.docxIndex } : {}),
      })
    } else {
      const g = { ...op.insert }
      delete g.hiddenBookmarks
      delete g.bookmarks
      out.push({ kind: 'generated', block: g })
    }
  }
  return { bytes: await saveDocx(parsed, out, options), parsed }
}

/** Keeps every block except the edits described by `edits` (index → change). */
export function editOnly(
  edits: Record<number, (g: GeneratedBlock) => void>,
): (blocks: Block[]) => EditorOp[] {
  return (blocks) => blocks.map((_, i) => (edits[i] ? { edit: i, change: edits[i] } : { keep: i }))
}

export interface WriteBack {
  content: string
  styles: string
  rctx: OoxmlToOdfContext
}

/** Writes the edited docx back into the original ODT strings. */
export async function writeBack(bridge: Bridge, edited: Uint8Array): Promise<WriteBack> {
  const parsed = await parseDocx(edited)
  const editedStylesXml = await readDocxPart(edited, 'word/styles.xml')
  if (FULL_REGISTRY)
    return fullWriteBack(bridge.doc, bridge.map, parsed, bridge.registry, editedStylesXml)
  const rctx = new OoxmlToOdfContext(bridge.doc, bridge.map, parsed, bridge.registry, {
    editedStylesXml,
  })
  rebuildOdtBody(rctx)
  updateOdtStyles(rctx)
  const patches = rctx.finish()
  return {
    content: applyTextPatches(bridge.doc.contentXml, patches['content.xml']),
    styles: applyTextPatches(bridge.doc.stylesXml ?? '', patches['styles.xml']),
    rctx,
  }
}

/** The inner XML of office:text. */
export function bodyOf(contentXml: string): string {
  const open = contentXml.indexOf('<office:text>')
  return contentXml.slice(open + '<office:text>'.length, contentXml.lastIndexOf('</office:text>'))
}

/** The text of a run list. */
export const runText = (block: Block | GeneratedBlock): string =>
  (block.runs ?? []).map((r) => r.text).join('')

/**
 * Replaces `[from, to)` of a generated paragraph's text with `insert`, editing
 * runs in place like typing does (the inserted text joins the run at `from`).
 */
export function replaceText(g: GeneratedBlock, from: number, to: number, insert: string): void {
  let at = 0
  let inserted = false
  for (const run of g.runs) {
    const start = at
    const end = at + run.text.length
    at = end
    const a = Math.max(from, start)
    const b = Math.min(to, end)
    let text = run.text
    if (b > a) text = text.slice(0, a - start) + text.slice(b - start)
    if (!inserted && from >= start && from <= end) {
      const k = from - start
      text = text.slice(0, k) + insert + text.slice(k)
      inserted = true
    }
    run.text = text
  }
  if (!inserted) g.runs.push({ text: insert })
  g.runs = g.runs.filter((r) => r.text !== '' || r.image || r.noteRef)
}
