// Bundles the preloads of the shell (the stage 3 shell contract, section 4):
// one IIFE per surface, every `electron` import replaced by the bridge, into
// crates/shell/out/preloads/<Surface>.js, which the shell injects as that
// webview's initialization script (src/preload.rs includes them).
//
//   node crates/shell/bridge/preloads.mjs
//
// The preload sources (`PRELOADS` of crates/shell-contract/src/channels.rs)
// stay as they are. Besides the surfaces it builds `_measure.js`, the page
// of `--measure-dialog`, and `manifest.json`.
import { build } from 'esbuild'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const bridge = dirname(fileURLToPath(import.meta.url))
const root = resolve(bridge, '../../..')
const out = resolve(bridge, '../out/preloads')

/** `PRELOADS` of channels.rs: surface, source, and the globals the source exposes */
function preloadSpecs() {
  const text = readFileSync(join(root, 'crates/shell-contract/src/channels.rs'), 'utf8')
  const at = text.indexOf('pub const PRELOADS')
  if (at < 0) throw new Error('channels.rs has no PRELOADS')
  const specs = []
  const entry =
    /PreloadSpec\s*\{\s*surface:\s*(\w+),\s*source:\s*"([^"]+)",\s*globals:\s*&\[([^\]]*)\]/g
  for (const m of text.slice(at).matchAll(entry)) {
    const globals = [...m[3].matchAll(/"([^"]+)"/g)].map((g) => g[1])
    specs.push({ surface: m[1], source: m[2], globals })
  }
  return specs
}

const common = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome140',
  alias: { electron: join(bridge, 'electron-entry.ts') },
  inject: [join(bridge, 'process-shim.ts')],
  // `customConditions` of tsconfig.base.json: workspace packages by their source
  conditions: ['seuoffice-source'],
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  logLevel: 'warning',
}

async function bundle(entry, file) {
  await build({ ...common, entryPoints: [entry], outfile: join(out, file) })
  return readFileSync(join(out, file), 'utf8')
}

const specs = preloadSpecs()
if (specs.length !== 19) {
  throw new Error(`PRELOADS lists ${specs.length} preloads, the contract says 19`)
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const manifest = {}
const failures = []
for (const spec of specs) {
  const source = join(root, spec.source)
  if (!existsSync(source)) {
    failures.push(`${spec.surface}: ${spec.source} does not exist`)
    continue
  }
  try {
    const code = await bundle(source, `${spec.surface}.js`)
    // each global the table names must be exposed by the bundle: a source
    // that exposed it through a name this check cannot see would be noticed here
    const missing = spec.globals.filter(
      (g) => !code.includes(JSON.stringify(g)) && !code.includes(`'${g}'`),
    )
    if (missing.length > 0) failures.push(`${spec.surface}: no ${missing.join(', ')} in the bundle`)
    if (/require\(["']electron["']\)|from ["']electron["']/.test(code)) {
      failures.push(`${spec.surface}: the bundle still imports electron`)
    }
    manifest[spec.surface] = {
      source: spec.source,
      file: `${spec.surface}.js`,
      bytes: Buffer.byteLength(code),
      globals: spec.globals,
    }
  } catch (error) {
    failures.push(`${spec.surface}: ${String(error?.message ?? error).split('\n')[0]}`)
  }
}

await bundle(join(bridge, 'measure-entry.ts'), '_measure.js')

writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

if (failures.length > 0) {
  for (const failure of failures) console.error(`preloads: ${failure}`)
  process.exit(1)
}
console.log(
  `preloads: ${Object.keys(manifest).length} bundles and _measure.js in ${relative(process.cwd(), out) || '.'}`,
)
