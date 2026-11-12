/**
 * The environment variables a person was told to set under the old prefix are
 * taken over by one module, `@seuoffice/i18n/old-names-env`. It works only if
 * every process loads it before anything else, so each process entry point has
 * it as its first import. The entry points are read from the build
 * configurations, so a new one without the import fails here.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENV_PREFIX, OLD_ENV_NAMES } from '../src/old-names'

const ROOT = resolve(__dirname, '../../..')
const TAKE_OVER = "import '@seuoffice/i18n/old-names-env'"

const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

/** The tracked files under `paths` that match `pattern` (`git grep` exits with 1 when none does) */
function filesMatching(pattern: string, ...paths: string[]): string[] {
  try {
    return execFileSync('git', ['grep', '-l', '-E', pattern, '--', ...paths], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    })
      .split('\n')
      .filter((path) => path !== '')
  } catch (error) {
    if ((error as { status?: number }).status === 1) return []
    throw error
  }
}

/** The `main: { ... }` block of an electron-vite configuration */
function mainBlock(config: string): string {
  const start = config.search(/\bmain:\s*\{/)
  if (start < 0) return ''
  let depth = 0
  for (let i = config.indexOf('{', start); i < config.length; i++) {
    if (config[i] === '{') depth++
    else if (config[i] === '}' && --depth === 0) return config.slice(start, i + 1)
  }
  return config.slice(start)
}

/** Every file a process with an environment starts in */
function entryPoints(): string[] {
  const entries: string[] = []

  // one Electron main per electron-vite configuration: src/main/index.ts unless the config names another
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    const config = `apps/${app}/electron.vite.config.ts`
    if (!existsSync(join(ROOT, config))) continue
    if (/\b(?:input|entry)\s*:/.test(mainBlock(read(config)))) {
      throw new Error(`${config} names its own main entry: teach this test to read it`)
    }
    entries.push(`apps/${app}/src/main/index.ts`)
  }

  // worker threads and utility processes: each is bundled from a `?modulePath` import of a main
  const importers = filesMatching('\\?modulePath', 'apps/*/src/main/*.ts').filter(
    (path) => !path.endsWith('.d.ts'),
  )
  for (const importer of importers) {
    for (const match of read(importer).matchAll(/from '([^']+)\?modulePath'/g)) {
      entries.push(`${relative(ROOT, resolve(ROOT, dirname(importer), match[1]!))}.ts`)
    }
  }

  // the command: what its build script bundles
  for (const match of read('packages/cli/build.mjs').matchAll(
    /entryPoints:\s*\[join\(here, '([^']+)'\)\]/g,
  )) {
    entries.push(`packages/cli/${match[1]!}`)
  }

  return entries.sort()
}

describe('the take-over of environment variables set under the old prefix', () => {
  const entries = entryPoints()

  it('finds the entry points of every kind of process', () => {
    expect(entries).toContain('apps/shell/src/main/index.ts')
    expect(entries).toContain('apps/shell/src/main/pdf-structure/pdf-structure-process.ts')
    expect(entries).toContain('apps/shell/src/main/file-index/extract-worker.ts')
    expect(entries).toContain('packages/cli/src/cli.ts')
  })

  it.each(entries)('is the first import of %s', (entry) => {
    expect(read(entry).match(/^import\b[^\n]*/m)?.[0]).toBe(TAKE_OVER)
  })

  it('covers every process that reads one of those variables: no renderer, preload or web source does', () => {
    // help topics name the variables for the reader; a Markdown file reads nothing
    const sources = (dir: string) => [`${dir}/*`, `:(exclude)${dir}/*.md`]
    const pattern = `(${OLD_ENV_NAMES.map((name) => ENV_PREFIX + name).join('|')})([^A-Z0-9_]|$)`
    expect(
      filesMatching(
        pattern,
        ...sources('apps/*/src/renderer'),
        ...sources('apps/*/src/preload'),
        ...sources('apps/*/src/web'),
        ...sources('apps/web/src'),
        ...sources('packages/web-platform/src'),
      ),
    ).toEqual([])
    // the search itself works: the same pattern finds the readers there are
    expect(filesMatching(pattern, 'packages/cli/src/*')).toContain('packages/cli/src/audit.ts')
    expect(filesMatching('import', 'apps/*/src/renderer/*').length).toBeGreaterThan(100)
  })
})
