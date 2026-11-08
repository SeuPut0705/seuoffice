/**
 * Home's three ways into the generate window: a Starred group's "make a new
 * document from this group", the selection bar and the file-row menu.
 */
import type { Lang } from '@genoffice/i18n'
import './globals'
import { generateText, type GenerateStringKey } from '../i18n/strings-generate'

export function openGenerateWithPaths(paths: readonly string[]): void {
  if (paths.length === 0) return
  void window.aiOfficeGenerate?.openWithPaths([...paths])
}

export function openGenerateWithGroup(group: string): void {
  void window.aiOfficeGenerate?.openWithGroup(group)
}

/** the entry labels live with the window's own strings */
export function generateEntryLabel(
  lang: Lang,
  key: Extract<GenerateStringKey, `homeMakeFrom${string}`>,
): string {
  return generateText(lang, key)
}
