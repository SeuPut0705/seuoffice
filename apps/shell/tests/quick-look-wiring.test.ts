import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Fixed by reading the source: the preview window must stay sandboxed, its
 * preload and page must be bundled, and the two shell preloads must not share a
 * value module. A shared value module becomes one chunk both preloads require,
 * and a sandboxed preload cannot require a sibling file — the window goes blank
 * (this is what broke the shell before: quick-look-api was shared, so the home
 * preload failed to load and Home rendered white).
 */

const src = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

// Value imports only, spanning multiple lines (the older single-line regex in
// the generate wiring test misses a multi-line `import { … } from '…'`).
const valueImports = (text: string) =>
  [...text.matchAll(/^import\s+(?!type\b)[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1])

// electron is external to the bundle, so both preloads may require it without
// forming a shared chunk.
const bundled = (specs: string[]) => specs.filter((s) => s !== 'electron' && !s.startsWith('node:'))

describe('the Quick Look preview window and its wiring', () => {
  it('is sandboxed and isolated like every shell window', () => {
    const win = src('../src/main/quick-look/quick-look-window.ts')
    expect(win).toMatch(/contextIsolation: true/)
    expect(win).toMatch(/nodeIntegration: false/)
    expect(win).toMatch(/sandbox: true/)
    expect(win).toMatch(/safeExternalUrl\(url\)/)
  })

  it('is configured once and built as its own preload and page', () => {
    const index = src('../src/main/index.ts')
    expect(index.match(/configureQuickLookWindow\(/g)).toHaveLength(1)
    const config = src('../electron.vite.config.ts')
    expect(config).toMatch(/'quick-look': resolve\(__dirname, 'src\/preload\/quick-look\.ts'\)/)
    expect(config).toMatch(/'quick-look': resolve\(__dirname, 'src\/renderer\/quick-look\.html'\)/)
  })

  it('keeps the two preloads from sharing a bundled module (a shared chunk breaks a sandboxed preload)', () => {
    const home = bundled(valueImports(src('../src/preload/index.ts')))
    const window = bundled(valueImports(src('../src/preload/quick-look.ts')))
    expect(home.filter((path) => window.includes(path))).toEqual([])
    // the window preload bundles nothing but its own api module: the shell
    // preload already bundles @genoffice/i18n transitively, and importing it
    // here too would form a shared chunk even though the paths differ.
    expect(window).toEqual(['../shared/quick-look-api'])
  })
})
