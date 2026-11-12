/**
 * `@seuoffice/ui/template-fonts` in the web build (seuofficeWebAliases points the specifier here):
 * the same table, with each file's URL in the one shared folder the web build copies the fonts to
 * (apps/web/scripts/build.mjs), beside the app folders. A face registered from such a URL is
 * fetched only when text first uses its family.
 */
export * from '../../ui/src/template-fonts'

/** The shared folder, relative to an app page (`<site>/<app>/index.html`). */
export const TEMPLATE_FONTS_WEB_DIR = '../template-fonts/'

/** The absolute URL of a bundled font file, resolved against the app page. */
export function templateFontUrl(file: string): string {
  return new URL(`${TEMPLATE_FONTS_WEB_DIR}${encodeURIComponent(file)}`, document.baseURI).href
}
