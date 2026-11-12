import type JSZip from 'jszip'
import type { EmbeddedFontLineMetrics, EmbeddedFont, FontTableEntry } from './types'
import { invoke } from './engine'
import { zipCall } from './engine-hand'

/** word/fontTable.xml → substitution hints (altName / PANOSE / family / pitch) */
export function parseFontTable(xml: string): FontTableEntry[] {
  return invoke('parseFontTable', [xml]) as never
}
export function isSfnt(bytes: Uint8Array): boolean {
  return invoke('isSfnt', [bytes]) as never
}
/** hhea line box of a single sfnt face in em units; null without head/hhea */
export function sfntLineMetrics(bytes: Uint8Array): EmbeddedFontLineMetrics | null {
  return invoke('sfntLineMetrics', [bytes]) as never
}
/**
 * Undo the ECMA-376 17.8.1 obfuscation: the first 32 bytes are XORed with the
 * fontKey GUID's 16 bytes taken in reverse order. A missing/zero key or a part
 * that already carries an sfnt magic is returned as is.
 */
export function deobfuscateOdttf(bytes: Uint8Array, fontKey: string | undefined): Uint8Array {
  return invoke('deobfuscateOdttf', [bytes, fontKey]) as never
}
/** fontTable embed slots → de-obfuscated faces; unparseable parts are skipped */
export async function readEmbeddedFonts(
  zip: JSZip,
  fontTable: readonly FontTableEntry[],
): Promise<EmbeddedFont[]> {
  return zipCall('readEmbeddedFonts', zip, [fontTable], false) as never
}
