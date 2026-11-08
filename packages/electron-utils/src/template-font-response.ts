/// The main-process answer to a renderer's template-font URL
/// (templateFontUrl in @genoffice/ui/template-fonts): the Word editor's media scheme
/// handler, which serves every editor inside the shell, and a standalone sheets app
/// both answer with this. Node only (reads the file); no Electron.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { templateFontFileOf } from '@genoffice/ui/template-fonts'

const FONT_MIME: Readonly<Record<string, string>> = { ttf: 'font/ttf', otf: 'font/otf' }

/**
 * The listed file the URL names, read from `dir` (the template font folder) when it
 * is asked for, or 404 when the folder lacks it (the renderer's chain then falls back
 * like for any missing font). Null for every other URL, which the scheme's other
 * handlers own. Only listed file names reach the disk, so no path escapes `dir`.
 */
export async function templateFontResponse(
  url: string,
  dir: string,
  read: (path: string) => Promise<Uint8Array> = readFile,
): Promise<Response | null> {
  const file = templateFontFileOf(url)
  if (!file) return null
  let bytes: Uint8Array
  try {
    bytes = await read(join(dir, file))
  } catch {
    return new Response(null, { status: 404 })
  }
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': FONT_MIME[file.split('.').pop()?.toLowerCase() ?? ''] ?? 'font/sfnt',
      'Content-Length': String(bytes.byteLength),
      // fonts load in CORS mode; the renderer's origin is another scheme (or a dev server)
      'Access-Control-Allow-Origin': '*',
    },
  })
}
