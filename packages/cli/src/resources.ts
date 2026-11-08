import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_BINARY_NAME, SKILL_NAME } from './names'

/**
 * Two layouts: packaged (Resources/cli/genoffice.cjs next to Resources/wasm,
 * Resources/native, Resources/ocr — see apps/shell/electron-builder.cjs) and
 * the dev checkout (packages/cli/{src,dist} inside the monorepo).
 */
function scriptDir(): string {
  if (typeof __dirname === 'string') return __dirname
  return dirname(fileURLToPath(import.meta.url))
}

let cachedResources: string | null | undefined
export function packagedResourcesDir(): string | null {
  if (cachedResources !== undefined) return cachedResources
  const candidate = resolve(scriptDir(), '..')
  cachedResources = existsSync(join(candidate, 'wasm', 'pdfium.wasm')) ? candidate : null
  return cachedResources
}

let cachedRepo: string | null | undefined
export function repoRoot(): string | null {
  if (cachedRepo !== undefined) return cachedRepo
  let dir = scriptDir()
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf-8')).name === 'genoffice') {
          cachedRepo = dir
          return dir
        }
      } catch {}
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  cachedRepo = null
  return null
}

export function pdfiumWasmPath(): string {
  if (process.env.GENOFFICE_PDFIUM_WASM) return process.env.GENOFFICE_PDFIUM_WASM
  const packaged = packagedResourcesDir()
  if (packaged) return join(packaged, 'wasm', 'pdfium.wasm')
  const root = repoRoot()
  if (root) {
    try {
      return createRequire(join(root, 'package.json')).resolve('@embedpdf/pdfium/pdfium.wasm')
    } catch {}
  }
  throw new Error('pdfium.wasm not found (set GENOFFICE_PDFIUM_WASM)')
}

/**
 * The harfbuzz subsetter wasm the translated-PDF writer embeds fonts with.
 * Packaged: Resources/wasm/hb-subset.wasm (apps/shell/electron-builder.cjs
 * ships it for the PDF editor). The app's own lookup falls back on
 * process.resourcesPath, which a Node process does not have, so the command
 * line resolves the path itself and hands it over.
 */
export function hbSubsetWasmPath(): string {
  if (process.env.GENOFFICE_HB_SUBSET_WASM) return process.env.GENOFFICE_HB_SUBSET_WASM
  const packaged = packagedResourcesDir()
  if (packaged) return join(packaged, 'wasm', 'hb-subset.wasm')
  const root = repoRoot()
  if (root) {
    // the copy the PDF editor depends on (and the packaged build ships) first
    for (const from of [join(root, 'apps', 'pdf', 'package.json'), join(root, 'package.json')]) {
      const r = createRequire(from)
      try {
        return r.resolve('harfbuzzjs/hb-subset.wasm')
      } catch {}
      try {
        // harfbuzzjs >= 1 seals its subpaths; the wasm sits beside the entry point
        const p = join(dirname(r.resolve('harfbuzzjs')), 'harfbuzz-subset.wasm')
        if (existsSync(p)) return p
      } catch {}
    }
  }
  throw new Error('hb-subset.wasm not found (set GENOFFICE_HB_SUBSET_WASM)')
}

/** The rhwp engine that reads HWP / HWPX documents (see @genoffice/file-parse/hwp). */
export function rhwpWasmPath(): string {
  if (process.env.GENOFFICE_RHWP_WASM) return process.env.GENOFFICE_RHWP_WASM
  const packaged = packagedResourcesDir()
  if (packaged) return join(packaged, 'wasm', 'rhwp_bg.wasm')
  const root = repoRoot()
  if (root) {
    try {
      return createRequire(join(root, 'package.json')).resolve('@rhwp/core/rhwp_bg.wasm')
    } catch {}
  }
  throw new Error('rhwp_bg.wasm not found (set GENOFFICE_RHWP_WASM)')
}

export function xlsxSidecarPath(): string | null {
  if (process.env.XLSX_SIDECAR_PATH) return process.env.XLSX_SIDECAR_PATH
  const executable = process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar'
  const packaged = packagedResourcesDir()
  const candidates = [
    ...(packaged ? [join(packaged, 'native', executable)] : []),
    ...(repoRoot()
      ? [join(repoRoot()!, 'apps/sheets/native/xlsx-engine/target/release', executable)]
      : []),
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

export function ocrHelperPath(): string | null {
  const helper = process.platform === 'darwin' ? 'vision-ocr' : 'win-ocr.exe'
  const packaged = packagedResourcesDir()
  const candidates = [
    ...(packaged ? [join(packaged, 'ocr', helper)] : []),
    ...(repoRoot() ? [join(repoRoot()!, 'packages/pdf2docx/ocr-helper', helper)] : []),
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

/** skills/ieumoffice/SKILL.md as shipped beside this bundle (Resources/cli/skills) or in the checkout. */
export function bundledSkillPath(): string | null {
  const packaged = packagedResourcesDir()
  const candidates = [
    ...(packaged ? [join(packaged, 'cli', 'skills', SKILL_NAME, 'SKILL.md')] : []),
    ...(repoRoot() ? [join(repoRoot()!, 'skills', SKILL_NAME, 'SKILL.md')] : []),
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

/** Linux names the binary from electron-builder's `linux.executableName`; it sits in the product's own /opt folder. */
const LINUX_APP_BINARY = 'ieumoffice'

export interface AppLaunch {
  command: string
  args: string[]
}

/**
 * How to start the IeumOffice GUI: the app binary that hosts this CLI, an installed app, or the dev checkout.
 * Only this product's own install locations are probed: an upstream GenOffice on the machine is never started.
 */
export function appLaunch(env: NodeJS.ProcessEnv = process.env): AppLaunch | null {
  if (env.GENOFFICE_APP_BIN) return { command: env.GENOFFICE_APP_BIN, args: [] }
  if (packagedResourcesDir() && process.versions.electron) {
    return { command: process.execPath, args: [] }
  }
  // a checkout drives its own build: an installed app may be older than this CLI
  const root = repoRoot()
  if (root) {
    const electron = devElectronBinary(root)
    if (electron) return { command: electron, args: [join(root, 'apps', 'shell')] }
  }
  const installed = installedAppBinaries(env).find((p) => existsSync(p))
  if (installed) return { command: installed, args: [] }
  return null
}

/** Where an installed copy of this product keeps its binary, the install hosting this CLI first. */
export function installedAppBinaries(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  resources: string | null = packagedResourcesDir(),
): string[] {
  const shipped = resources ? appBinaryForResources(resources, platform) : null
  switch (platform) {
    case 'darwin':
      return [
        ...(shipped ? [shipped] : []),
        `/Applications/${APP_BINARY_NAME}.app/Contents/MacOS/${APP_BINARY_NAME}`,
        join(homedir(), `Applications/${APP_BINARY_NAME}.app/Contents/MacOS/${APP_BINARY_NAME}`),
      ]
    case 'win32':
      return [
        ...(shipped ? [shipped] : []),
        env.LOCALAPPDATA
          ? join(env.LOCALAPPDATA, 'Programs', APP_BINARY_NAME, `${APP_BINARY_NAME}.exe`)
          : '',
        env.ProgramFiles ? join(env.ProgramFiles, APP_BINARY_NAME, `${APP_BINARY_NAME}.exe`) : '',
      ].filter(Boolean)
    default:
      // /usr/bin/genoffice is the upstream app's name: never a place to look for ours
      return [...(shipped ? [shipped] : []), `/opt/${APP_BINARY_NAME}/${LINUX_APP_BINARY}`]
  }
}

export function appBinaryForResources(resources: string, platform: NodeJS.Platform): string {
  const install = dirname(resources)
  if (platform === 'darwin') return join(install, 'MacOS', APP_BINARY_NAME)
  if (platform === 'win32') return join(install, `${APP_BINARY_NAME}.exe`)
  return join(install, LINUX_APP_BINARY)
}

/**
 * The real Electron executable of the checkout, not the npm shim in
 * node_modules/.bin: the shim is a Node script that cannot be executed on
 * Windows and that swallows SIGKILL, orphaning the binary it spawned.
 */
function devElectronBinary(root: string): string | null {
  try {
    const resolved = createRequire(join(root, 'package.json'))('electron') as unknown
    return typeof resolved === 'string' && existsSync(resolved) ? resolved : null
  } catch {
    return null
  }
}
