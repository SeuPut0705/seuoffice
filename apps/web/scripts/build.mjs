/**
 * `npm run build -w @seuoffice/web`: the static web bundle in apps/web/dist.
 *
 * Each suite app in APPS builds from its own apps/<app>/vite.web.config.ts
 * into dist/<app>/; the launcher page goes to dist/ last. Apps that need a
 * generated input build it first: sheets its xlsx engine for wasm, hwp the
 * rhwp studio (needs network for the first run).
 */
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const web = resolve(here, '..')
const repo = resolve(web, '../..')

/** suite apps in the web bundle, in build order */
const APPS = ['pdf']

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repo,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})`)
}

rmSync(resolve(web, 'dist'), { recursive: true, force: true })

if (APPS.includes('sheets')) run('node', ['apps/sheets/native/xlsx-wasm/build.mjs'])
if (APPS.includes('hwp')) run('npm', ['run', 'studio', '-w', '@genoffice/hwp'])

for (const app of APPS) {
  console.log(`\n[web] building ${app}`)
  await build({ configFile: resolve(repo, `apps/${app}/vite.web.config.ts`) })
}

console.log('\n[web] building the launcher')
await build({ configFile: resolve(web, 'vite.config.ts') })
