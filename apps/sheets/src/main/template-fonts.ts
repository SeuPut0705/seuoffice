/// The bundled template fonts on the main side: a standalone app's answer to a
/// renderer's template-font URL (templateFontResponse, the same answer the Word
/// editor's media scheme gives inside the shell: one listed file, read when a face is
/// first used), and the @font-face rules the hidden PDF export / print window needs
/// (it loads the print HTML from a temp file with scripting off, so it only sees
/// fonts the page itself declares). Both read the one installed folder
/// (templateFontsDir); nothing is copied, downloaded or installed into the OS.

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { app, protocol } from 'electron'

import { templateFontResponse } from '@genoffice/electron-utils/template-font-response'
import { templateFontsDir } from '@genoffice/electron-utils/template-fonts-dir'
import {
  TEMPLATE_FONT_FACE_REGISTRATIONS,
  TEMPLATE_FONT_SCHEME,
} from '@genoffice/ui/template-fonts'

/// The installed folder (resources/template-fonts), or the checkout's in a dev run.
/// The app path is the shell's when this code runs inside the shell and the sheets
/// app's when it runs alone; both sit two levels below the repo root.
export function sheetsTemplateFontsDir(): string {
  return templateFontsDir({
    isPackaged: app.isPackaged,
    getAppPath: () => app.getAppPath(),
    resourcesPath: process.resourcesPath,
  })
}

/// A standalone sheets app answers the template-font URLs itself (after app ready;
/// registerRendererScheme already made the scheme privileged). Inside the shell the
/// Word editor's main owns this scheme and serves the same files on the same URLs,
/// so the shell must not call this.
export function installStandaloneTemplateFontProtocol(): void {
  const dir = sheetsTemplateFontsDir()
  protocol.handle(TEMPLATE_FONT_SCHEME, async (request) => {
    return (await templateFontResponse(request.url, dir)) ?? new Response(null, { status: 404 })
  })
}

/// The rules name the files by file URL: the export window loads its page from a
/// file URL too, and the browser fetches only the faces the page's text uses.
/// pathToFileURL percent-encodes what a CSS string cannot hold (`"`, brackets,
/// spaces), so the URL sits safely inside url("…").
export function templateFontFaceCss(dir: string): string {
  return TEMPLATE_FONT_FACE_REGISTRATIONS.map(
    ({ family, file, weight }) =>
      `@font-face { font-family: '${family}'; src: url("${pathToFileURL(join(dir, file)).href}"); font-weight: ${weight}; }`,
  ).join('\n')
}

/** The print HTML with the bundled faces declared ahead of its own styles. */
export function withTemplateFontFaces(html: string, dir: string): string {
  const style = `<style>\n${templateFontFaceCss(dir)}\n</style>`
  // after <head>, else after the doctype (a style ahead of it would switch the page to quirks mode)
  const anchor = /<head\b[^>]*>/i.exec(html) ?? /^\s*<!doctype[^>]*>/i.exec(html)
  const at = anchor ? anchor.index + anchor[0].length : 0
  return html.slice(0, at) + style + html.slice(at)
}
