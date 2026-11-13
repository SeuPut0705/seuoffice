/**
 * The import boundary of the fake Electron (tools/main-diff/electron-fake.ts):
 * a name a main-process module imports from 'electron' is reachable only when
 * the stub exports it. A name missing there reads as undefined in the module
 * under test, whatever the case's Electron fakes, so a group would have to
 * stub it locally. Every name the sources import must come through.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { useElectron } from '../main-diff/electron-fake.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))

/** every value (not type) named in `import { … } from 'electron'` under apps/*\/src and packages/*\/src */
function importedNames(): string[] {
  const names = new Set<string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'tests' || entry === '__tests__') continue
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(ts|tsx|mts)$/.test(entry) && !/\.test\.|\.d\.ts$/.test(entry)) {
        const text = readFileSync(path, 'utf8')
        for (const m of text.matchAll(
          /import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"]electron['"]/g,
        )) {
          if (m[1]) continue
          for (const part of m[2].split(',')) {
            const name = part.trim()
            if (name && !name.startsWith('type ')) names.add(name.split(/\s+as\s+/)[0].trim())
          }
        }
      }
    }
  }
  for (const top of ['apps', 'packages']) {
    for (const pkg of readdirSync(join(root, top))) {
      try {
        if (statSync(join(root, top, pkg, 'src')).isDirectory()) walk(join(root, top, pkg, 'src'))
      } catch {
        /* no src */
      }
    }
  }
  return [...names].sort()
}

describe('the fake electron module', () => {
  it('exports every name the main-process sources import', () => {
    const names = importedNames()
    // a guard against a scan that finds nothing
    expect(names).toContain('ipcMain')
    const fake = Object.fromEntries(names.map((name) => [name, { fakeOf: name }]))
    useElectron(fake)
    // `require`, as the CommonJS the apps compile to under tsx reaches it
    const electron = createRequire(import.meta.url)('electron') as Record<string, unknown>
    const missing = names.filter((name) => electron[name] !== fake[name])
    expect(missing).toEqual([])
  })
})
