// The template font set ships once: one extraResources entry copies the repo folder
// next to the editor modules, and no editor imports the files as a build asset (which
// would put a copy into every editor's build output).
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  TEMPLATE_FONTS_DIR_NAME,
  TEMPLATE_FONTS_REPO_DIR,
} from '@genoffice/electron-utils/template-fonts-dir'

const require = createRequire(import.meta.url)
const SHELL = resolve(import.meta.dirname, '..')
const ROOT = resolve(SHELL, '../..')

interface Resource {
  from: string
  to: string
  filter?: string[]
}

function loadBuilderConfig(platform: string) {
  const configModule = { exports: {} as ReturnType<typeof require> }
  runInNewContext(readFileSync(join(SHELL, 'electron-builder.cjs'), 'utf8'), {
    module: configModule,
    __dirname: SHELL,
    process: { platform, arch: 'x64', env: {} },
    require: (id: string) =>
      id === 'node:fs' ? { ...require(id), existsSync: () => true } : require(id),
  })
  return configModule.exports as {
    extraResources: Resource[]
    mac: { extraResources: Resource[] }
    win: { extraResources: Resource[] }
    linux: { extraResources: Resource[] }
  }
}

describe('template fonts in the installer', () => {
  it('ships the template font folder exactly once, whole, into resources', () => {
    const config = loadBuilderConfig('win32')
    const all = [
      ...config.extraResources,
      ...config.mac.extraResources,
      ...config.win.extraResources,
      ...config.linux.extraResources,
    ]
    const entries = all.filter(
      (r) => r.to === TEMPLATE_FONTS_DIR_NAME || r.from.includes('template-fonts'),
    )
    expect(entries).toHaveLength(1)
    const [entry] = entries
    expect(config.extraResources).toContain(entry)
    expect(entry!.to).toBe(TEMPLATE_FONTS_DIR_NAME)
    expect(entry!.filter).toBeUndefined()
    expect(resolve(SHELL, entry!.from)).toBe(resolve(ROOT, TEMPLATE_FONTS_REPO_DIR))
  })

  it('is never imported as a build asset by an editor', () => {
    // what Vite copies into a build: an import, a dynamic import, new URL(…, import.meta.url)
    // or a CSS url() naming a file path (a runtime URL with a scheme is not copied)
    const assetRef =
      /(?:from\s+|import\s*\(\s*|new URL\(\s*|url\(\s*)['"]?(?![a-z][a-z0-9+.-]*:)[^'"()\s]*template-fonts\/[^'"()\s]+\.(?:ttf|otf)/i
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, e.name)
        if (e.isDirectory()) {
          if (e.name !== 'node_modules') walk(path)
        } else if (/\.(ts|tsx|css|html)$/.test(e.name)) {
          if (assetRef.test(readFileSync(path, 'utf8'))) {
            offenders.push(path)
          }
        }
      }
    }
    for (const app of readdirSync(join(ROOT, 'apps'))) {
      const src = join(ROOT, 'apps', app, 'src')
      try {
        walk(src)
      } catch {
        // an app without a src folder imports nothing
      }
    }
    expect(offenders).toEqual([])
  }, 60_000)
})
