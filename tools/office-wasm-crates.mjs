/**
 * The crates compiled into office_wasm.wasm that are not this repository's own
 * work: what tools/gen-third-party-notices.mjs lists in its office-wasm section
 * and what electron-builder.cjs checks that section against.
 *
 * The graph is the one crates/office-wasm/build.mjs builds: the normal
 * dependencies of office-wasm for wasm32-wasip1 with its default features
 * (`cargo tree`, which resolves features for that package alone), less proc
 * macros, which run in the compiler and link nothing. A crate of the
 * workspace is the repository's own work, under its LICENSE and NOTICE, unless
 * it carries a licence of its own: a licence file in its directory or a
 * `license` other than the workspace's. Such a crate is vendored or ported
 * code (crates/vendor/regress, crates/mtx after libeot, the rhwp tree) and is
 * listed with its own licence files.
 *
 *   node tools/office-wasm-crates.mjs   prints {"count": N, "crates": [...]}
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { licenseFiles } from './license-text.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const OFFICE_WASM_MANIFEST = join(ROOT, 'crates/Cargo.toml')
export const OFFICE_WASM_TARGET = 'wasm32-wasip1'

const cargo = (args) =>
  execFileSync('cargo', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  })

/** the license the workspace's own crates inherit */
function workspaceLicense() {
  const manifest = readFileSync(OFFICE_WASM_MANIFEST, 'utf8')
  return /\[workspace\.package\][\s\S]*?^license\s*=\s*"([^"]+)"/m.exec(manifest)?.[1] ?? null
}

/**
 * `{ name, version, spdx, url, dir }` per crate, sorted by name and version, or
 * null when cargo cannot resolve the graph (cargo missing, a path dependency
 * not prepared, no network for an uncached crate).
 */
export function officeWasmCrates() {
  let tree
  let meta
  try {
    tree = cargo([
      'tree',
      '--locked',
      '--manifest-path',
      OFFICE_WASM_MANIFEST,
      '-p',
      'office-wasm',
      '--target',
      OFFICE_WASM_TARGET,
      '-e',
      'normal,no-proc-macro',
      '--prefix',
      'none',
      '--format',
      '{p}',
    ])
    meta = JSON.parse(
      cargo([
        'metadata',
        '--format-version',
        '1',
        '--locked',
        '--filter-platform',
        OFFICE_WASM_TARGET,
        '--manifest-path',
        OFFICE_WASM_MANIFEST,
      ]),
    )
  } catch {
    return null
  }
  // `name vX.Y.Z` or `name vX.Y.Z (path)`, with ` (*)` where cargo tree saw it before
  const linked = new Set(
    tree
      .split(/\r?\n/)
      .map((line) => /^(\S+) v(\S+)/.exec(line.trim()))
      .filter(Boolean)
      .map(([, name, version]) => `${name} ${version}`),
  )
  const own = workspaceLicense()
  const isOwnWork = (p) =>
    p.source === null &&
    (p.license ?? own) === own &&
    licenseFiles(dirname(p.manifest_path)).length === 0
  return meta.packages
    .filter((p) => linked.has(`${p.name} ${p.version}`) && !isOwnWork(p))
    .map((p) => ({
      name: p.name,
      version: p.version,
      spdx: p.license ?? (p.license_file ? `see ${p.license_file}` : 'see repository'),
      url: p.repository ?? `https://crates.io/crates/${p.name}`,
      dir: dirname(p.manifest_path),
      /** a crate of the workspace (vendored or ported code with a license of its own): its directory */
      path:
        p.source === null ? relative(ROOT, dirname(p.manifest_path)).split(sep).join('/') : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const crates = officeWasmCrates()
  if (crates === null) {
    console.error('office-wasm-crates: cargo could not resolve the office_wasm.wasm graph')
    process.exit(1)
  }
  console.log(
    JSON.stringify({ count: crates.length, crates: crates.map((c) => `${c.name} ${c.version}`) }),
  )
}
