import { TEMPLATE_FONT_FACE_REGISTRATIONS, templateFontUrl } from '@genoffice/ui/template-fonts'
import { noteTemplateFontFamilies } from './line-metrics'

/**
 * The design templates' bundled fonts in the Word editor. Each face is registered
 * under its real family name from the one shipped copy (served by the main process on
 * templateFontUrl's URLs), so a document naming the family draws, measures,
 * prints and exports in the real face: cssFontFamily keeps the declared name at the
 * head of every chain, and the rest of the chain still catches characters the face
 * lacks. URL-backed faces load only when text first uses them; the 'loadingdone'
 * listeners then re-measure, as for the fonts.css faces.
 */

/**
 * Single-spacing line factor of each family the editor draws real: the face's hhea
 * total (ascender - descender + lineGap over unitsPerEm), the box Word lays a face it
 * renders for real with (see lineHeightFactor's embedded-face rule). Korean faces are
 * East Asian in Word, which meters them by its East Asian rule, hhea total x 1.3 (the
 * rule that reproduces Batang 1.3029, Malgun 1.7371 and Meiryo 1.9429 there).
 * tests/template-fonts.test.ts recomputes every value from the shipped files.
 */
export const TEMPLATE_LINE_FACTORS: Readonly<Record<string, number>> = {
  Pretendard: 1.5514,
  'Noto Serif KR': 1.8681,
  'Black Han Sans': 1.625,
  'Do Hyeon': 1.625,
  'Gowun Dodum': 1.8824,
  'Gowun Batang': 1.8824,
  'Bebas Neue': 1.2,
  'Space Grotesk': 1.276,
  'Playfair Display': 1.333,
  'Archivo Black': 1.088,
}

type FontFaceCtor = new (
  family: string,
  source: string,
  descriptors: FontFaceDescriptors,
) => FontFace

/**
 * Register the bundled faces with the document's font set; returns the families
 * registered (none where the page has no font loading API, as in jsdom).
 */
export function registerTemplateFonts(
  fonts: { add(face: FontFace): unknown } | undefined = typeof document === 'undefined'
    ? undefined
    : document.fonts,
  Face: FontFaceCtor | undefined = typeof FontFace === 'undefined' ? undefined : FontFace,
): string[] {
  if (!fonts || !Face) return []
  const families = new Set<string>()
  for (const spec of TEMPLATE_FONT_FACE_REGISTRATIONS) {
    const face = new Face(spec.family, `url("${templateFontUrl(spec.file)}")`, {
      weight: spec.weight,
      style: 'normal',
      display: 'block',
    })
    fonts.add(face)
    families.add(spec.family)
  }
  noteTemplateFontFamilies(
    [...families].map((family) => ({ family, lineFactor: TEMPLATE_LINE_FACTORS[family] })),
  )
  return [...families]
}
