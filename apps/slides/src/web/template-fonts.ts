// The design templates' fonts for the web slides session. main/fonts.ts reads the template files
// by name from the folder setTemplateFontDir gives it, with synchronous reads; here that folder is
// a path in the in-memory fs, filled before layout with only the families the deck names, fetched
// from the web build's shared font folder. The renderer then draws them through the private-face
// bytes (privateFontFaces / privateFontData), as on the desktop.
import { join } from 'node:path'
import type { PackageArchive } from '@seuoffice/pptx-engine'
import {
  TEMPLATE_FONTS,
  templateFontUrl,
  type TemplateFontFamily,
} from '@seuoffice/ui/template-fonts'
import { setTemplateFontDir } from '../main/fonts'
import { putFile } from './memfs'

const DIR = '/template-fonts'
const TYPEFACE = /\btypeface="([^"]+)"/g

setTemplateFontDir(() => DIR)

/** The template families named by any typeface in the deck's parts (slides, masters, themes...) */
export function templateFamiliesIn(archive: Pick<PackageArchive, 'entries'>): TemplateFontFamily[] {
  const named = new Set<string>()
  const decoder = new TextDecoder()
  for (const [path, bytes] of archive.entries) {
    if (!path.startsWith('ppt/') || !path.endsWith('.xml')) continue
    for (const match of decoder.decode(bytes).matchAll(TYPEFACE))
      named.add(match[1]!.trim().toLowerCase())
  }
  return TEMPLATE_FONTS.filter((family) => named.has(family.family.toLowerCase()))
}

const loaded = new Set<string>()

/**
 * Fetches the files of the template families the deck names into the in-memory fs; true when a
 * new file landed (the font registry must be rebuilt). A file that cannot be fetched leaves its
 * family to the fallback chain, as before this font set reached the web.
 */
export async function loadTemplateFontsFor(
  archive: Pick<PackageArchive, 'entries'>,
): Promise<boolean> {
  const files = templateFamiliesIn(archive)
    .flatMap((family) => family.faces.map((face) => face.file))
    .filter((file) => !loaded.has(file))
  const landed = await Promise.all(
    files.map(async (file) => {
      try {
        const response = await fetch(templateFontUrl(file))
        if (!response.ok) throw new Error(`answered ${response.status}`)
        putFile(join(DIR, file), new Uint8Array(await response.arrayBuffer()))
        loaded.add(file)
        return true
      } catch (error) {
        console.warn(`seuoffice web: template font ${file} not loaded`, error)
        return false
      }
    }),
  )
  return landed.includes(true)
}
