import { type DefaultFonts, type StyleUpsert } from './style-upsert'
import type { ParsedDoc } from './types'
import type { StyleInfo } from './types'
import type { DocDefaults } from './types'
import { invokeAsync } from './engine'

/** Resolve live style inheritance without reparsing the document body or its media. */
export async function previewFontSettings(
  parsed: ParsedDoc,
  upserts: StyleUpsert[],
  defaults?: DefaultFonts,
): Promise<{ styles: Map<string, StyleInfo>; docDefaults?: DocDefaults }> {
  return invokeAsync(
    'previewFontSettings',
    [
      {
        originalBytes: parsed.internal.originalBytes,
        themeColors: parsed.themeColors,
        themeFonts: parsed.themeFonts,
      },
      upserts,
      defaults,
    ],
    { shape: { k: 'obj', f: { styles: { k: 'map' } } } },
  ) as never
}
