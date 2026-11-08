import type { Lang } from '@genoffice/i18n'
import {
  CJK_FAMILY_ALIASES,
  JAPANESE_FAMILIES,
  KOREAN_FAMILIES,
  KOREAN_FAMILY_READINGS,
  SIMPLIFIED_CJK_FAMILIES,
  TRADITIONAL_CJK_FAMILIES,
} from '@genoffice/i18n'

/**
 * Font dropdown candidates grouped by script, ordered per UI language so the
 * fonts a user is most likely to want appear at the top (e.g. Western fonts
 * for the US market, Japanese fonts for the Japanese market). Shared by every
 * app's font pickers so the suite offers one consistent list. Windows and
 * macOS names for the same script sit side by side — pickers hide the ones
 * the running machine proves absent (see partitionFontFamilies), so a Windows
 * user never sees the macOS names and vice versa. The localized name data
 * lives in the i18n locale dictionary (packages/i18n/src/font-names.ts).
 */
const LATIN = [
  'Aptos',
  'Calibri',
  'Calibri Light',
  'Arial',
  'Times New Roman',
  'Georgia',
  'Verdana',
  'Tahoma',
  'Cambria',
  'Garamond',
  'Trebuchet MS',
  'Segoe UI',
  'Courier New',
  'Impact',
  // title faces bundled with the design templates (./template-fonts.ts)
  'Bebas Neue',
  'Space Grotesk',
  'Playfair Display',
  'Archivo Black',
]

export const BUILTIN_FONT_FAMILIES: readonly string[] = [
  ...LATIN,
  ...SIMPLIFIED_CJK_FAMILIES,
  ...JAPANESE_FAMILIES,
  ...KOREAN_FAMILIES,
  ...TRADITIONAL_CJK_FAMILIES,
]

export function fontFamiliesFor(lang: Lang): readonly string[] {
  switch (lang) {
    case 'zh':
      return [
        ...SIMPLIFIED_CJK_FAMILIES,
        ...LATIN,
        ...JAPANESE_FAMILIES,
        ...KOREAN_FAMILIES,
        ...TRADITIONAL_CJK_FAMILIES,
      ]
    case 'zh-TW':
      return [
        ...TRADITIONAL_CJK_FAMILIES,
        ...LATIN,
        ...SIMPLIFIED_CJK_FAMILIES,
        ...JAPANESE_FAMILIES,
        ...KOREAN_FAMILIES,
      ]
    case 'ja':
      return [
        ...JAPANESE_FAMILIES,
        ...LATIN,
        ...SIMPLIFIED_CJK_FAMILIES,
        ...KOREAN_FAMILIES,
        ...TRADITIONAL_CJK_FAMILIES,
      ]
    case 'ko':
      return [
        ...KOREAN_FAMILIES,
        ...LATIN,
        ...JAPANESE_FAMILIES,
        ...SIMPLIFIED_CJK_FAMILIES,
        ...TRADITIONAL_CJK_FAMILIES,
      ]
    default:
      return [
        ...LATIN,
        ...JAPANESE_FAMILIES,
        ...SIMPLIFIED_CJK_FAMILIES,
        ...KOREAN_FAMILIES,
        ...TRADITIONAL_CJK_FAMILIES,
      ]
  }
}

/**
 * candidate spelling → every other known spelling of the same family, built
 * once from CJK_FAMILY_ALIASES: each table entry is one family's spelling set,
 * so within an entry every spelling maps to every other (a candidate under its
 * English name must also match the localized spelling, and vice versa).
 */
const FAMILY_SPELLINGS: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>()
  for (const [key, aliases] of Object.entries(CJK_FAMILY_ALIASES)) {
    const group = [key, ...aliases]
    for (const a of group) {
      const list = map.get(a)
      if (list) {
        for (const b of group) if (b !== a && !list.includes(b)) list.push(b)
      } else {
        map.set(
          a,
          group.filter((b) => b !== a),
        )
      }
    }
  }
  return map
})()

/** Every spelling we know for a family, its own name first. */
function familySpellings(family: string): readonly string[] {
  return [family, ...(FAMILY_SPELLINGS.get(family) ?? [])]
}

function isPresent(family: string, known: ReadonlySet<string>): boolean {
  return familySpellings(family).some((spelling) => known.has(spelling))
}

/**
 * Split a queryLocalFonts family list into picker sections: `builtin` holds the
 * candidates that exist on this machine, `system` holds the rest, both keeping the
 * caller's ordering. `knownAvailable` lists families the enumeration cannot see but
 * that are known installed (app-installed catalog fonts live in a private dir); they
 * keep their builtin slot without leaking into the system section.
 *
 * Presence is spelling-aware (see CJK_FAMILY_ALIASES in the i18n locale dictionary):
 * a candidate counts as present when *any* known spelling of it is reported, in
 * either direction — a localized zh candidate on a machine that reports `SimSun`,
 * or the English-named ja candidates on a Japanese Windows that reports the
 * localized name — so a candidate is never dropped for a spelling difference.
 * When the enumeration is unavailable, denied, or still loading (no system families)
 * every candidate is kept — offering a dead name beats hiding a real one.
 */
export function partitionFontFamilies(
  candidates: readonly string[],
  systemFamilies: readonly string[],
  knownAvailable: readonly string[] = [],
): { builtin: readonly string[]; system: readonly string[] } {
  // only the enumeration proves anything: catalog installs alone must not
  // turn the gate on and hide every candidate they do not cover
  if (systemFamilies.length === 0) return { builtin: [...candidates], system: [] }
  const known = new Set(systemFamilies)
  for (const f of knownAvailable) known.add(f)
  return {
    builtin: candidates.filter((f) => isPresent(f, known)),
    system: systemFamiliesBesidesCandidates(candidates, systemFamilies),
  }
}

/**
 * The machine-reported families a picker should list beside the candidates:
 * everything the enumeration returned that no candidate already covers by its
 * own name. Pickers that keep the full candidate list visible (the docs ribbon
 * and Font dialog) build their system section with this instead of
 * partitionFontFamilies, so no builtin shows up twice.
 */
export function systemFamiliesBesidesCandidates(
  candidates: readonly string[],
  systemFamilies: readonly string[],
): readonly string[] {
  const candidateSet = new Set(candidates)
  return systemFamilies.filter((f) => !candidateSet.has(f))
}

/** What the main process read from a family's font files (the enumeration reports English names only). */
export interface FontFamilyInfo {
  /** the font's own Korean family name */
  readonly ko?: string
  /** the font covers Hangul */
  readonly hangul: boolean
}

/** Keyed by the enumerated family name; families that are not Korean have no entry. */
export type FontFamilyInfoMap = ReadonlyMap<string, FontFamilyInfo>

/** Case-, space- and hyphen-insensitive, so `나눔 고딕` finds `나눔고딕` and `noto sans` finds `NotoSans`. */
const fold = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_]/g, '')

function koreanReadingsOf(family: string): readonly string[] {
  const lower = family.toLowerCase()
  for (const [key, readings] of Object.entries(KOREAN_FAMILY_READINGS)) {
    if (fold(family) === fold(key) || lower.startsWith(`${key.toLowerCase()} `)) return readings
  }
  return []
}

/** Every name a family answers to in a picker search: its own, its Korean name, its readings. */
function searchNamesOf(family: string, info?: FontFamilyInfoMap): readonly string[] {
  const ko = info?.get(family)?.ko
  return [family, ...(ko ? [ko] : []), ...koreanReadingsOf(family)]
}

/** Picker label: the family, with the font's own Korean name beside it when it has one. */
export function fontFamilyLabel(family: string, info?: FontFamilyInfoMap): string {
  const ko = info?.get(family)?.ko
  return ko ? `${family} (${ko})` : family
}

/** The typed text occurs anywhere in one of the family's names; an empty query matches all. */
export function matchesFontQuery(query: string, family: string, info?: FontFamilyInfoMap): boolean {
  const q = fold(query)
  return !q || searchNamesOf(family, info).some((name) => fold(name).includes(q))
}

/**
 * Type-ahead target for typed text: the first family whose name it starts (the
 * only case a font box can complete inline), else the first it matches anywhere
 * or by a Korean name.
 */
export function findFontMatch(
  query: string,
  families: readonly string[],
  info?: FontFamilyInfoMap,
): { readonly family: string; readonly prefix: boolean } | undefined {
  const typed = query.trim().toLowerCase()
  if (!typed) return undefined
  const starts = families.find((f) => f.toLowerCase().startsWith(typed))
  if (starts !== undefined) return { family: starts, prefix: true }
  const anywhere = families.find((f) => matchesFontQuery(query, f, info))
  return anywhere === undefined ? undefined : { family: anywhere, prefix: false }
}

/**
 * The family a committed font-box text stands for: another name of a listed
 * family typed in full (its Korean name, say) commits that family, since the
 * document must hold the name the system resolves. Anything else is kept as typed.
 */
export function familyForTypedName(
  text: string,
  families: readonly string[],
  info?: FontFamilyInfoMap,
): string {
  const typed = fold(text)
  if (!typed || families.some((f) => fold(f) === typed)) return text
  return families.find((f) => searchNamesOf(f, info).some((name) => fold(name) === typed)) ?? text
}

/** Split a picker's system section so Korean fonts can be listed ahead of the rest. */
export function splitHangulFamilies(
  families: readonly string[],
  info?: FontFamilyInfoMap,
): { readonly hangul: readonly string[]; readonly other: readonly string[] } {
  const hangul: string[] = []
  const other: string[] = []
  for (const f of families) (info?.get(f)?.hangul ? hangul : other).push(f)
  return { hangul, other }
}
