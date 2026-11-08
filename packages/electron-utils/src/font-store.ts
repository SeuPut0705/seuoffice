/** The user font store, shared by every app that can install a font file. */
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Everything the store needs from its host, so none of it imports electron. */
export interface FontStoreEnv {
  /** where user-installed files (and files an earlier version downloaded) live */
  readonly dir: string
  /** Injected, not imported: the name-table reader lives in the pptx-tied slides registry, and only hosts offering a local install have one. */
  readonly fontFileFamilies?: (path: string) => readonly string[]
}

/** The sfnt magic a real font file starts with; anything else is not one. */
const SFNT_MAGIC = new Set(['00010000', '4f54544f', '74746366', '74727565'])

/** Returns [] when the host injects no name-table reader, because it has no local install to offer. */
export function installLocalFontFiles(env: FontStoreEnv, paths: readonly string[]): string[] {
  const readFamilies = env.fontFileFamilies
  if (!readFamilies) return []
  mkdirSync(env.dir, { recursive: true })
  const installed: string[] = []
  for (const path of paths) {
    let head: string
    try {
      head = readFileSync(path).subarray(0, 4).toString('hex')
    } catch {
      continue
    }
    if (!SFNT_MAGIC.has(head)) continue
    const families = readFamilies(path)
    const primary = families[0]
    if (!primary) continue
    const ext =
      basename(path)
        .match(/\.(ttc|otc|otf)$/i)?.[1]
        ?.toLowerCase() ?? 'ttf'
    // Family-derived name is the registry index key; the suffix keeps one family's style files apart.
    const styleTag = /bold\s*italic/i.test(basename(path))
      ? '-BoldItalic'
      : /bold/i.test(basename(path))
        ? '-Bold'
        : /italic|oblique/i.test(basename(path))
          ? '-Italic'
          : ''
    const dest = join(env.dir, `${primary.replace(/[\\/:]/g, '')}${styleTag}.${ext}`)
    try {
      copyFileSync(path, dest)
      installed.push(...families)
    } catch {
      /* unreadable/locked source: skip */
    }
  }
  return [...new Set(installed)]
}
