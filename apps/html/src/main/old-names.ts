/**
 * The app-owned asset list's name before this product took its own names
 * (decision 0024). An assets folder that has it keeps using it. Kept in step
 * with apps/markdown/src/main/old-names.ts and packages/pdf-structure.
 */
export const OLD_ASSET_MANIFEST_FILENAMES: readonly string[] = ['.genoffice-assets.json']

/**
 * The name a NEW assets folder gets its list under. Still the old one: 0.12.37
 * reads only that name and would treat every picture as the user's own. Switch
 * this to ASSET_MANIFEST_FILENAME only when a version that reads both has been
 * the stable release for at least 14 days.
 */
export const ASSET_MANIFEST_FILENAME_WRITTEN = '.genoffice-assets.json'
