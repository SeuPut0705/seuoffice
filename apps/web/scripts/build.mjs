/**
 * `npm run build -w @seuoffice/web`: the static web bundle in apps/web/dist.
 *
 * Each suite app in APPS builds from its own apps/<app>/vite.web.config.ts
 * into dist/<app>/; the launcher page goes to dist/ last. Apps that need a
 * generated input build it first: sheets its xlsx engine for wasm, hwp the
 * rhwp studio (needs network for the first run).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const web = resolve(here, '..')
const repo = resolve(web, '../..')

/** suite apps in the web bundle, in build order */
const APPS = ['pdf', 'hwp', 'docs', 'slides', 'sheets']

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repo,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})`)
}

/**
 * The studio's old-Hangul face, which it loads at start from studio/fonts/. build-studio.mjs leaves
 * rhwp's font folder out of its checkout (not every font there may be redistributed); this one is
 * Adobe Source Han Serif K under SIL OFL 1.1, renamed by rhwp to drop the Reserved Font Name
 * (rhwp assets/font-rules/changes/issue-4969-oldhangul-license-webfont.json, which pins the hash).
 * Read from the studio's own pinned checkout, so it is the file the studio was built against.
 */
const OLD_HANGUL = {
  font: 'RHWPOldHangul-Regular.woff2',
  license: 'SourceHanSerifK-OFL.txt',
  sha256: '1a45a61e9a320c1bc62ca1401f7b23ceffffe8133dc2a9650ad4e12524f8dcab',
}

function copyOldHangulFont() {
  const require = createRequire(resolve(repo, 'apps/hwp/package.json'))
  const core = JSON.parse(
    readFileSync(join(dirname(require.resolve('@rhwp/core')), 'package.json'), 'utf8'),
  )
  const checkout = resolve(repo, 'apps/hwp/node_modules/.cache/rhwp-studio', core.rhwp.tag)
  const show = (file) =>
    execFileSync('git', ['show', `HEAD:assets/fonts/${file}`], {
      cwd: checkout,
      maxBuffer: 16 * 1024 * 1024,
    })
  const font = show(OLD_HANGUL.font)
  const sha256 = createHash('sha256').update(font).digest('hex')
  if (sha256 !== OLD_HANGUL.sha256) throw new Error(`${OLD_HANGUL.font}: sha256 ${sha256}`)
  const out = resolve(web, 'dist/hwp/studio/fonts')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, OLD_HANGUL.font), font)
  writeFileSync(join(out, OLD_HANGUL.license), show(OLD_HANGUL.license))
}

rmSync(resolve(web, 'dist'), { recursive: true, force: true })

if (APPS.includes('sheets')) run('node', ['apps/sheets/native/xlsx-wasm/build.mjs'])
if (APPS.includes('hwp')) run('npm', ['run', 'studio', '-w', '@seuoffice/hwp'])

for (const app of APPS) {
  console.log(`\n[web] building ${app}`)
  await build({ configFile: resolve(repo, `apps/${app}/vite.web.config.ts`) })
}

console.log('\n[web] building the launcher')
await build({ configFile: resolve(web, 'vite.config.ts') })

// The design templates' fonts once for every app (templateFontUrl in
// packages/web-platform/src/template-fonts.ts), with their licenses and readme
cpSync(resolve(repo, 'packages/ui/template-fonts'), resolve(web, 'dist/template-fonts'), {
  recursive: true,
})

if (APPS.includes('hwp')) copyOldHangulFont()
