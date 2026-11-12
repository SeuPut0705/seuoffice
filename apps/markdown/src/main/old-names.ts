/**
 * Names this app wrote before this product took its own names (decision 0024).
 * Kept in step with apps/html/src/main/old-names.ts and packages/pdf-structure.
 */

/** The app-owned asset list in `assets/`. An assets folder that has it keeps using it. */
export const OLD_ASSET_MANIFEST_FILENAMES: readonly string[] = ['.genoffice-assets.json']

/** The marker of a conversion session folder under `<userData>/markdown-conversions` */
export const OLD_CONVERSION_SESSION_MARKERS: readonly string[] = [
  '.genoffice-markdown-conversion.json',
]
