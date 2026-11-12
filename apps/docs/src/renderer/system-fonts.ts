import { createSystemFontSource, useSystemFontSource, type SystemFonts } from '@genoffice/ui'
import { TEMPLATE_FONT_FAMILY_NAMES } from '@genoffice/ui/template-fonts'
import { setFontAliasLookup } from './line-metrics'

/// The families to ask the main process about: the enumeration plus the bundled
/// template families, which it cannot see but the main process reads from their
/// folder (Hangul coverage routes a Pretendard pick to the East Asian slot too).
export function familiesForInfo(families: readonly string[]): readonly string[] {
  const listed = new Set(families)
  return [...families, ...TEMPLATE_FONT_FAMILY_NAMES.filter((f) => !listed.has(f))]
}

/// The enumeration names every family in English only, so the main process
/// reads the Korean names from the font files; without them the list still works.
const source = createSystemFontSource((families) =>
  window.desktop.fontFamilyInfo(familiesForInfo(families)),
)

/// Loads when the first picker mounts (and again from a picker's open click if
/// that failed); every picker of the page shares the list. Returns every
/// family: the pickers dedupe the candidate names where the two sections
/// merge (docs keeps every candidate visible, so it never partitions).
export function useSystemFontFamilies(): SystemFonts & { readonly load: () => void } {
  return useSystemFontSource(source)
}

/** declared family name -> the other spellings of the face behind it, the
 *  canonical (en-US) one first. The map is filled from the main process, which
 *  reads the installed faces' name tables (genoffice#2449). */
const aliasMap = new Map<string, readonly string[]>()
const aliasListeners = new Set<(names: readonly string[]) => void>()

/** the key the alias map is indexed by: a declared name, without its quotes */
const aliasKey = (name: string): string =>
  name
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase()

// the lookup reads the live map, so an alias applies the moment it lands
setFontAliasLookup((name) => aliasMap.get(aliasKey(name)) ?? null)

/**
 * Ask the main process for the other spellings of the installed faces behind
 * these names. The answer comes over IPC, so it lands after the first layout:
 * the subscribers re-style the document when it does (genoffice#2449).
 */
export function resolveFontAliases(names: readonly string[]): Promise<void> {
  if (!names.length) return Promise.resolve()
  const request = queryAliases(names)
  pendingAliases = request
  return request
}

async function queryAliases(names: readonly string[]): Promise<void> {
  let answered: Record<string, readonly string[]>
  try {
    answered = (await window.desktop.fontAliases(names)) ?? {}
  } catch {
    return
  }
  // every answered name is announced, not only the new ones: a document laid
  // out before the map was filled must still be re-styled
  const covered: string[] = []
  for (const [name, aliases] of Object.entries(answered)) {
    if (!aliases?.length) continue
    aliasMap.set(aliasKey(name), aliases)
    covered.push(name)
  }
  if (!covered.length) return
  for (const listener of [...aliasListeners]) listener(covered)
}

/**
 * Subscribe to the alias map landing. The callback gets the names that have
 * an alias, so a document that declares none of them is not reflowed.
 */
export function onFontAliasesChanged(cb: (names: readonly string[]) => void): () => void {
  aliasListeners.add(cb)
  return () => {
    aliasListeners.delete(cb)
  }
}

/** the alias request of the last open, so a headless export can wait for it */
let pendingAliases: Promise<void> = Promise.resolve()

/**
 * Resolves when the alias request of the last open has settled. The headless
 * export waits for it: the map lands after the first layout, and the export
 * must not run against the fallback layout the alias replaces (genoffice#2449).
 */
export function fontAliasesSettled(timeoutMs = 30_000): Promise<void> {
  return Promise.race([
    pendingAliases,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ])
}
