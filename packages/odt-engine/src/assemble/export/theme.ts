/**
 * When a docx → ODT conversion reports `theme`.
 *
 * The docx engine resolves theme fonts (`w:asciiTheme` …, including empty
 * East Asian and complex-script slots) and theme colours (`w:themeColor`,
 * `w:themeFill`, with tint and shade) against the document's theme while it
 * parses, and the editor shows those values. The ODT stores the same resolved
 * values, so it looks the same and only the link to the theme goes; that is
 * not reported. A document that merely ships a theme part is not reported.
 *
 * What is reported is a theme reference in the exported content (body,
 * headers and footers, and the styles and document defaults they use) that the
 * theme cannot answer: the theme part is missing or unreadable for a font
 * reference, the referenced Latin slot is empty, or a colour names a slot the
 * theme does not hold. The engine then falls back to the literal value Word
 * cached next to the reference, and the ODT keeps that fallback, which Word
 * would have replaced with the theme's value. One per such reference.
 */
import type { ParsedDoc, ThemeColors, ThemeFonts } from '@genoffice/docx-engine'

/** `w:themeColor` value → colour scheme slot (Word's default mapping). */
const COLOR_SLOTS: Record<string, keyof ThemeColors> = {
  dark1: 'dk1',
  text1: 'dk1',
  light1: 'lt1',
  background1: 'lt1',
  dark2: 'dk2',
  text2: 'dk2',
  light2: 'lt2',
  background2: 'lt2',
  accent1: 'accent1',
  accent2: 'accent2',
  accent3: 'accent3',
  accent4: 'accent4',
  accent5: 'accent5',
  accent6: 'accent6',
  hyperlink: 'hlink',
  followedHyperlink: 'folHlink',
}

/** Slots the engine answers without a theme value. */
const COLOR_FALLBACK = new Set<keyof ThemeColors>(['dk1', 'lt1'])

/** The XML a conversion takes formatting from. */
export interface ThemeSources {
  documentXml: string
  stylesXml: string
  /** header and footer parts */
  parts: string[]
}

/** Theme references the ODT cannot carry as Word would show them. */
export function unresolvedThemeReferences(parsed: ParsedDoc, sources: ThemeSources): number {
  const content = [sources.documentXml, ...sources.parts]
  const used = usedStyles(parsed, content)
  const scanned = [...content]
  for (const m of sources.stylesXml.matchAll(/<w:style\b[^>]*>[\s\S]*?<\/w:style>/g)) {
    const id = /\bw:styleId="([^"]*)"/.exec(m[0])?.[1]
    if (id && used.has(id)) scanned.push(m[0])
  }
  const defaults = /<w:docDefaults\b[\s\S]*?<\/w:docDefaults>/.exec(sources.stylesXml)?.[0]
  if (defaults) scanned.push(defaults)

  let count = 0
  for (const xml of scanned) {
    for (const m of xml.matchAll(/\bw:(?:asciiTheme|hAnsiTheme|eastAsiaTheme|cstheme)="([^"]*)"/g))
      if (!fontResolves(m[1], parsed.themeFonts ?? null)) count++
    for (const m of xml.matchAll(/\bw:theme(?:Color|Fill)="([^"]*)"/g))
      if (!colorResolves(m[1], parsed.themeColors ?? null)) count++
  }
  return count
}

function fontResolves(ref: string, fonts: ThemeFonts | null): boolean {
  if (!fonts) return false
  switch (ref) {
    case 'majorHAnsi':
    case 'majorAscii':
      return !!fonts.major
    case 'minorHAnsi':
    case 'minorAscii':
      return !!fonts.minor
    // empty East Asian and complex-script slots resolve to the language's face
    case 'majorEastAsia':
    case 'minorEastAsia':
    case 'majorBidi':
    case 'minorBidi':
      return true
    default:
      return false
  }
}

function colorResolves(name: string, colors: ThemeColors | null): boolean {
  const slot = COLOR_SLOTS[name]
  if (!slot) return false
  if (COLOR_FALLBACK.has(slot)) return true
  const value = colors?.[slot]
  return typeof value === 'string' && /^[0-9A-Fa-f]{6}$/.test(value)
}

/** Styles the content uses, their parents, and the defaults Word applies. */
function usedStyles(parsed: ParsedDoc, content: string[]): Set<string> {
  const used = new Set<string>()
  for (const xml of content)
    for (const m of xml.matchAll(/<w:(?:pStyle|rStyle|tblStyle)\s+w:val="([^"]*)"/g)) used.add(m[1])
  for (const s of parsed.styles.values()) if (s.isDefault) used.add(s.styleId)
  for (const id of [...used]) {
    let next = parsed.styles.get(id)?.basedOn
    for (let guard = 0; next && guard < 20; guard++) {
      used.add(next)
      next = parsed.styles.get(next)?.basedOn
    }
  }
  return used
}
