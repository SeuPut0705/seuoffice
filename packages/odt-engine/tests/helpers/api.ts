/**
 * Test plumbing for the public API: opening through `odtToDocx`, saving with
 * the editor's way (`editorSave`) and `saveOdt`, and comparing packages entry
 * by entry.
 */
import type { Block } from '@seuoffice/docx-engine'
import JSZip from 'jszip'
import { type BridgeMap, odtToDocx, saveOdt } from '../../src'
import { type EditorOp, editorSave } from './bridge'
import { type OdtArchive, readArchive } from './odt-archive'

/** One part of a docx, read with JSZip (undefined when the package has none). */
export async function docxPart(docx: Uint8Array, path: string): Promise<string | undefined> {
  return (await JSZip.loadAsync(docx)).file(path)?.async('string')
}

export const textOf = (pkg: OdtArchive, name: string): string => pkg.text(name) ?? ''

/** Opens with the public API and saves after the editor's operations. */
export async function roundTrip(
  odt: Uint8Array,
  ops: (blocks: Block[]) => EditorOp[],
  options: Parameters<typeof editorSave>[2] = {},
): Promise<{ saved: Uint8Array; bridge: BridgeMap; docx: Uint8Array; edited: Uint8Array }> {
  const { docxBytes, bridge } = await odtToDocx(odt)
  const { bytes } = await editorSave(docxBytes, ops, options)
  const saved = await saveOdt({ originalOdt: odt, bridge, editedDocx: bytes })
  return { saved, bridge, docx: docxBytes, edited: bytes }
}

export interface PackageDiff {
  /** names in order */
  order: string[]
  /** entries whose uncompressed bytes differ */
  changed: string[]
  added: string[]
  removed: string[]
  mimetypeFirst: boolean
  mimetypeStored: boolean
}

const same = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export async function diffPackages(before: Uint8Array, after: Uint8Array): Promise<PackageDiff> {
  const a = await readArchive(before)
  const b = await readArchive(after)
  const names = new Set(a.entries.map((e) => e.name))
  const changed: string[] = []
  const added: string[] = []
  for (const e of b.entries) {
    const o = a.get(e.name)
    if (!o) added.push(e.name)
    else if (!same(o.bytes, e.bytes)) changed.push(e.name)
    names.delete(e.name)
  }
  return {
    order: b.entries.map((e) => e.name),
    changed,
    added,
    removed: [...names],
    mimetypeFirst: b.mimetypeFirst,
    mimetypeStored: b.mimetypeStored,
  }
}

/** The original order of entries with mimetype moved first (what a re-pack writes). */
export async function expectedOrder(original: Uint8Array): Promise<string[]> {
  const pkg = await readArchive(original)
  const names = pkg.entries.map((e) => e.name)
  return ['mimetype', ...names.filter((n) => n !== 'mimetype')]
}

/** Strings around the first difference of two texts, for readable failures. */
export function changedRegion(before: string, after: string): { before: string; after: string } {
  let i = 0
  while (i < before.length && i < after.length && before[i] === after[i]) i++
  let a = before.length
  let b = after.length
  while (a > i && b > i && before[a - 1] === after[b - 1]) {
    a--
    b--
  }
  return { before: before.slice(i, a), after: after.slice(i, b) }
}
