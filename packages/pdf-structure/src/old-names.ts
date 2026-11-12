/**
 * Names this product wrote into users' folders before it took its own names
 * (decision 0024). This package does not depend on @seuoffice/i18n, so the
 * ones it honours are listed here. No other source file spells an old name.
 */

/**
 * The editors' app-owned asset list in `assets/` beside a Markdown or HTML
 * document. An assets folder keeps the name it was given: the list found there
 * is read and updated in place, never renamed or duplicated.
 */
export const OLD_ASSET_MANIFEST_FILENAMES: readonly string[] = ['.genoffice-assets.json']

/**
 * The name a NEW assets folder gets its list under. Still the old one: 0.12.37
 * reads only that name and would treat every picture as the user's own. Switch
 * this to ASSET_MANIFEST_FILENAME only when a version that reads both has been
 * the stable release for at least 14 days.
 */
export const ASSET_MANIFEST_FILENAME_WRITTEN = '.genoffice-assets.json'
