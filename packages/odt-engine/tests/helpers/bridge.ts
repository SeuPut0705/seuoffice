/**
 * Test plumbing over the public API: ODT → bridge docx (`odtToDocx`), the
 * editor's way of saving an edited paragraph (rawPPr reuse, `saveDocx`), and
 * the write-back into the original ODT (`saveOdt`, then the parts read out of
 * the saved package).
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
} from '@seuoffice/docx-engine'
import { type BridgeMap, type ConversionReport, odtToDocx, saveOdt } from '../../src'
import { type OdtArchive, readArchive } from './odt-archive'

export interface Bridge {
  /** the ODT as opened */
  odt: Uint8Array
  archive: OdtArchive
  map: BridgeMap
  docx: Uint8Array
  report: ConversionReport
  /** content.xml of the opened ODT */
  content: string
  /** styles.xml of the opened ODT, null when it has none */
  styles: string | null
}

export async function odtToBridge(bytes: Uint8Array): Promise<Bridge> {
  const archive = await readArchive(bytes)
  const { docxBytes, bridge, report } = await odtToDocx(bytes)
  // the map must survive a JSON round trip (it crosses IPC)
  const map = JSON.parse(JSON.stringify(bridge)) as BridgeMap
  return {
    odt: bytes,
    archive,
    map,
    docx: docxBytes,
    report,
    content: archive.text('content.xml') as string,
    styles: archive.text('styles.xml') ?? null,
  }
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

export interface PackageChanges {
  /** entries the save added, in package order */
  add: Array<{ path: string; data: Uint8Array; mediaType: string }>
  /** entries the save removed, in original order */
  remove: string[]
}

export interface WriteBack {
  /** the saved ODT (the original bytes, same object, when nothing changed) */
  odt: Uint8Array
  archive: OdtArchive
  content: string
  /** '' when the package has no styles.xml */
  styles: string
  manifest: string
  changes: PackageChanges
  /** the automatic styles the save added to `part` (elements absent from the original) */
  newAutomaticStyles(part: 'content.xml' | 'styles.xml'): string[]
}

/** The top-level elements of the first `office:automatic-styles` of a part. */
function automaticStyleElements(xml: string | null | undefined): string[] {
  if (!xml) return []
  const open = /<office:automatic-styles(\s[^>]*)?(\/?)>/.exec(xml)
  if (!open || open[2] === '/') return []
  const from = open.index + open[0].length
  const to = xml.indexOf('</office:automatic-styles>', from)
  const inner = xml.slice(from, to)
  const out: string[] = []
  const tag = /<(\/?)([A-Za-z][\w:.-]*)[^>]*?(\/?)>/g
  let depth = 0
  let start = -1
  for (let m = tag.exec(inner); m; m = tag.exec(inner)) {
    if (m[1] === '/') {
      depth--
      if (depth === 0) out.push(inner.slice(start, m.index + m[0].length))
    } else if (m[3] === '/') {
      if (depth === 0) out.push(m[0])
    } else {
      if (depth === 0) start = m.index
      depth++
    }
  }
  return out
}

function newElements(before: string | null | undefined, after: string | null | undefined) {
  const remaining = automaticStyleElements(before)
  const added: string[] = []
  for (const element of automaticStyleElements(after)) {
    const at = remaining.indexOf(element)
    if (at >= 0) remaining.splice(at, 1)
    else added.push(element)
  }
  return added
}

/** The `manifest:media-type` the manifest declares for `path`, '' when it has none. */
function manifestMediaType(manifest: string, path: string): string {
  for (const entry of manifest.matchAll(/<manifest:file-entry\b[^>]*>/g)) {
    const fullPath = /manifest:full-path="([^"]*)"/.exec(entry[0])?.[1]
    if (fullPath === path) return /manifest:media-type="([^"]*)"/.exec(entry[0])?.[1] ?? ''
  }
  return ''
}

/** Saves the edited docx into the original ODT with the public API. */
export async function writeBack(bridge: Bridge, edited: Uint8Array): Promise<WriteBack> {
  const { odtBytes: odt } = await saveOdt({
    originalOdt: bridge.odt,
    bridge: bridge.map,
    editedDocx: edited,
  })
  const archive = odt === bridge.odt ? bridge.archive : await readArchive(odt)
  const content = archive.text('content.xml') as string
  const styles = archive.text('styles.xml') ?? ''
  const before = new Map(bridge.archive.entries.map((e) => [e.name, e]))
  const after = new Map(archive.entries.map((e) => [e.name, e]))
  const manifest = archive.text('META-INF/manifest.xml') ?? ''
  const changes: PackageChanges = {
    add: archive.entries
      .filter((e) => !before.has(e.name))
      .map((e) => ({
        path: e.name,
        data: e.bytes,
        mediaType: manifestMediaType(manifest, e.name),
      })),
    remove: bridge.archive.entries.map((e) => e.name).filter((name) => !after.has(name)),
  }
  return {
    odt,
    archive,
    content,
    styles,
    manifest,
    changes,
    newAutomaticStyles: (part) =>
      part === 'content.xml'
        ? newElements(bridge.content, content)
        : newElements(bridge.styles, styles),
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
