/// Bundled template fonts on the grid canvas. Each face is registered at boot as a
/// FontFace whose source is its URL (@genoffice/ui/template-fonts), so nothing is
/// read until text first uses the family: a cell drawn in it, a picker preview, or a
/// workbook that names it (loadTemplateFontsFor, before the first skeleton). Canvas
/// fillText still draws the fallback while a face is in flight, and Univer measures a
/// cell once, so a finished face re-lays the grid out (installTemplateFontRefresh).

import { TEMPLATE_FONT_FACE_REGISTRATIONS, templateFontUrl } from '@genoffice/ui/template-fonts'

import { TEMPLATE_FONT_FAMILY_KEYS } from '../shared/template-font-faces'
import type { WorkbookFile } from '../shared/desktop-api'

type FontFaceCtor = new (
  family: string,
  source: string,
  descriptors: FontFaceDescriptors,
) => FontFace

/// Registers every bundled face without fetching a byte; returns the families.
export function registerTemplateFonts(
  fonts: Pick<FontFaceSet, 'add'> | undefined = typeof document === 'undefined'
    ? undefined
    : document.fonts,
  Face: FontFaceCtor | undefined = typeof FontFace === 'undefined' ? undefined : FontFace,
): string[] {
  if (!fonts || !Face) return []
  const families = new Set<string>()
  for (const { family, file, weight } of TEMPLATE_FONT_FACE_REGISTRATIONS) {
    fonts.add(new Face(family, `url("${templateFontUrl(file)}")`, { weight, style: 'normal' }))
    families.add(family)
  }
  return [...families]
}

/** a CSS family name as FontFace.family reports it, without quotes, lowercased */
function familyKey(family: string): string {
  return family
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2')
    .toLowerCase()
}

export function isTemplateFontFamily(family: string | undefined | null): boolean {
  return !!family && TEMPLATE_FONT_FAMILY_KEYS.has(familyKey(family))
}

export interface TemplateFontUse {
  readonly family: string
  readonly bold?: boolean
}

/// Fetches the faces a workbook names before its first skeleton, so the Normal
/// font's digit width and the first layout measure the real face. Only bundled
/// families are loaded, each at the weights asked for; never throws.
export async function loadTemplateFontsFor(
  uses: Iterable<TemplateFontUse>,
  fonts: Pick<FontFaceSet, 'load'> | undefined = typeof document === 'undefined'
    ? undefined
    : document.fonts,
): Promise<void> {
  if (!fonts) return
  const wanted = new Set<string>()
  for (const { family, bold } of uses) {
    if (!isTemplateFontFamily(family)) continue
    const name = family.trim().replace(/["\\]/g, '')
    wanted.add(`${bold ? '700' : '400'} 16px "${name}"`)
  }
  await Promise.all([...wanted].map((font) => fonts.load(font).catch(() => [])))
}

/// The bundled families a workbook names: its cell styles (with their weight), the
/// Normal font's literal name and the theme fonts.
export function workbookTemplateFontUses(
  file: Pick<WorkbookFile, 'styles' | 'normalFontName' | 'themeFonts'>,
): TemplateFontUse[] {
  const uses: TemplateFontUse[] = []
  for (const style of file.styles) {
    if (isTemplateFontFamily(style.fontFamily))
      uses.push({ family: style.fontFamily!, bold: style.bold })
  }
  const named = [
    file.normalFontName?.replace(/^@/, ''),
    file.themeFonts?.major,
    file.themeFonts?.minor,
    file.themeFonts?.minorEa,
  ]
  for (const family of named) if (family && isTemplateFontFamily(family)) uses.push({ family })
  return uses
}

/// Calls `refresh` (once per frame at most) whenever a bundled face finishes loading.
export function installTemplateFontRefresh(
  refresh: () => void,
  fonts:
    Pick<FontFaceSet, 'addEventListener' | 'removeEventListener'> | undefined = typeof document ===
  'undefined'
    ? undefined
    : document.fonts,
  schedule: (run: () => void) => void = (run) => requestAnimationFrame(() => run()),
): () => void {
  if (!fonts) return () => {}
  let queued = false
  let disposed = false
  const listener = (event: Event): void => {
    const faces = (event as FontFaceSetLoadEvent).fontfaces ?? []
    if (!faces.some((face) => isTemplateFontFamily(face.family))) return
    if (queued) return
    queued = true
    schedule(() => {
      queued = false
      if (!disposed) refresh()
    })
  }
  fonts.addEventListener('loadingdone', listener)
  return () => {
    disposed = true
    fonts.removeEventListener('loadingdone', listener)
  }
}
