import { type DefaultFonts, type StyleUpsert } from './style-upsert'
import type { ParsedDoc } from './types'
import { invokeAsync } from './engine'

/** Resolve live style inheritance without reparsing the document body or its media. */
export async function previewFontSettings(
  parsed: ParsedDoc,
  upserts: StyleUpsert[],
  defaults?: DefaultFonts,
) {
  return invokeAsync('previewFontSettings', [parsed, upserts, defaults], { shape: {"k":"obj","f":{"styles":{"k":"map"}}} }) as never
}