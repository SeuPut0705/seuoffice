/**
 * The inventory of the Electron main process that decision 0030 splits into
 * batches: for every module (a file or a folder directly under an app's
 * `src/main`, and `packages/electron-utils/src`), its lines, the Electron
 * APIs it names, the IPC channels it registers, the Node built-ins it uses
 * for files and the OS, the npm packages it imports (native ones marked), and
 * the modules it imports, in any app. A module is Electron-free when
 * neither it nor any module it imports, directly or not, imports `electron`.
 *
 *   npx tsx tools/main-inventory/inventory.ts            # writes out/inventory.json
 *   npx tsx tools/main-inventory/inventory.ts --markdown # and prints the table
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const tool = dirname(fileURLToPath(import.meta.url))
const root = resolve(tool, '../..')

interface Module {
  /** `shell/update-attempt` or `shell/projects/` for a folder */
  id: string
  app: string
  files: number
  lines: number
  electron: string[]
  ipc: string[]
  node: string[]
  npm: string[]
  native: string[]
  seuoffice: string[]
  imports: string[]
  electronFree?: boolean
}

const isSource = (name: string): boolean =>
  /\.(ts|tsx|mts)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')

function sourcesUnder(path: string): string[] {
  if (statSync(path).isFile()) return isSource(path) ? [path] : []
  return readdirSync(path).flatMap((name) => sourcesUnder(join(path, name)))
}

/** npm packages that ship a compiled addon */
const nativeCache = new Map<string, boolean>()
function isNative(pkg: string): boolean {
  if (nativeCache.has(pkg)) return nativeCache.get(pkg)!
  const dir = join(root, 'node_modules', pkg)
  let native = false
  if (existsSync(dir)) {
    const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      gypfile?: boolean
      dependencies?: Record<string, string>
    }
    native =
      json.gypfile === true ||
      existsSync(join(dir, 'binding.gyp')) ||
      existsSync(join(dir, 'prebuilds')) ||
      Object.keys(json.dependencies ?? {}).some((d) => d === 'node-gyp-build' || d === 'bindings')
  }
  nativeCache.set(pkg, native)
  return native
}

const IPC_METHODS = ['handle', 'handleOnce', 'on', 'once']

function scanFile(file: string, mod: Module, moduleOf: (abs: string) => string | undefined): void {
  const text = readFileSync(file, 'utf8')
  mod.lines += text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const add = (list: string[], v: string): void => {
    if (!list.includes(v)) list.push(v)
  }
  const visit = (node: ts.Node): void => {
    let spec: string | undefined
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      spec = node.moduleSpecifier.text
      if (spec === 'electron' && !node.importClause?.isTypeOnly) {
        const bindings = node.importClause?.namedBindings
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            if (!el.isTypeOnly) {
              add(mod.electron, (el.propertyName ?? el.name).text)
            }
          }
        } else if (node.importClause?.name || (bindings && ts.isNamespaceImport(bindings))) {
          add(mod.electron, '*')
        }
      }
      if (node.importClause?.isTypeOnly) spec = undefined
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      spec = node.isTypeOnly ? undefined : node.moduleSpecifier.text
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      spec = node.arguments[0].text
    }
    if (spec !== undefined) {
      if (spec.startsWith('node:')) add(mod.node, spec.slice(5))
      else if (spec === 'electron') {
        // a static import is counted above; `await import('electron')` and
        // require count the names they destructure, or `*`
        if (ts.isCallExpression(node)) {
          let at: ts.Node = node.parent
          if (ts.isAwaitExpression(at)) at = at.parent
          if (ts.isVariableDeclaration(at) && ts.isObjectBindingPattern(at.name)) {
            for (const el of at.name.elements) {
              const name = el.propertyName ?? el.name
              add(mod.electron, ts.isIdentifier(name) ? name.text : '*')
            }
          } else add(mod.electron, '*')
        }
      } else if (spec.startsWith('.')) {
        const target = moduleOf(resolve(dirname(file), spec))
        if (target && target !== mod.id) add(mod.imports, target)
      } else {
        const pkg = spec.startsWith('@')
          ? spec.split('/').slice(0, 2).join('/')
          : spec.split('/')[0]
        if (pkg === '@seuoffice/electron-utils') {
          // its modules are in the inventory too: link them like a relative import
          add(mod.imports, `electron-utils/${spec.split('/')[2] ?? 'index'}`)
        } else if (pkg === '@seuoffice/html2docx') {
          // the one other package that imports electron
          add(mod.seuoffice, pkg)
          add(mod.electron, 'via @seuoffice/html2docx')
        } else if (pkg.startsWith('@seuoffice/')) add(mod.seuoffice, pkg)
        else {
          add(mod.npm, pkg)
          if (isNative(pkg)) add(mod.native, pkg)
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      IPC_METHODS.includes(node.expression.name.text) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'ipcMain' &&
      node.arguments.length > 0
    ) {
      add(mod.ipc, node.arguments[0].getText(sf).replace(/\s+/g, ''))
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

interface ModuleDir {
  app: string
  mainDir: string
  /** the top-level files and folders of `mainDir` that hold sources: one module each */
  entries: string[]
}

function moduleDir(app: string, mainDir: string): ModuleDir {
  const entries = readdirSync(mainDir).filter((name) => {
    const path = join(mainDir, name)
    return statSync(path).isDirectory() ? sourcesUnder(path).length > 0 : isSource(name)
  })
  return { app, mainDir, entries }
}

const idOf = (dir: ModuleDir, name: string): string =>
  statSync(join(dir.mainDir, name)).isDirectory()
    ? `${dir.app}/${name}/`
    : `${dir.app}/${name.replace(/\.(ts|tsx|mts)$/, '')}`

const apps = readdirSync(join(root, 'apps')).filter((app) =>
  existsSync(join(root, 'apps', app, 'src', 'main')),
)
const dirs: ModuleDir[] = [
  ...apps.map((app) => moduleDir(app, join(root, 'apps', app, 'src', 'main'))),
  moduleDir('electron-utils', join(root, 'packages', 'electron-utils', 'src')),
]

/** The module a file belongs to, in any app: a relative import may cross into
 * another app's main folder (shell/pdf-note-tabs imports markdown/note-append) */
function moduleOf(abs: string): string | undefined {
  for (const dir of dirs) {
    const rel = relative(dir.mainDir, abs)
    if (rel.startsWith('..') || isAbsolute(rel)) continue
    const head = rel.split(sep)[0]
    for (const name of dir.entries) {
      if (name === head || name.replace(/\.(ts|tsx|mts)$/, '') === head) return idOf(dir, name)
    }
  }
  return undefined
}

function modulesOf(dir: ModuleDir): Module[] {
  return dir.entries.map((name) => {
    const mod: Module = {
      id: idOf(dir, name),
      app: dir.app,
      files: 0,
      lines: 0,
      electron: [],
      ipc: [],
      node: [],
      npm: [],
      native: [],
      seuoffice: [],
      imports: [],
    }
    for (const file of sourcesUnder(join(dir.mainDir, name))) {
      mod.files++
      scanFile(file, mod, moduleOf)
    }
    for (const list of [mod.electron, mod.node, mod.npm, mod.native, mod.seuoffice, mod.imports])
      list.sort()
    return mod
  })
}

const modules: Module[] = dirs.flatMap(modulesOf)

const byId = new Map(modules.map((m) => [m.id, m]))
function electronFree(m: Module, seen = new Set<string>()): boolean {
  if (m.electronFree !== undefined) return m.electronFree
  if (seen.has(m.id)) return true
  seen.add(m.id)
  const free =
    m.electron.length === 0 &&
    !m.npm.includes('electron-updater') &&
    m.imports.every((id) => {
      const dep = byId.get(id)
      return !dep || electronFree(dep, seen)
    })
  if (seen.size === 1) m.electronFree = free
  return free
}
for (const m of modules) m.electronFree = electronFree(m)

/**
 * The batches of decision 0030, first rule that matches. Engine-bound modules
 * call a JavaScript library that has no Rust port yet (pdf-lib, pdfium, ...):
 * they move with the engine of stage 1 that replaces it. Entry modules hold
 * windows, menus, dialogs and IPC registration: they stay TypeScript until
 * the Rust shell of stage 3, thinner after each batch.
 */
const B1 = new Set([
  'shell/update-attempt',
  'shell/update-cache',
  'shell/update-build-channel',
  'shell/update-log',
  'shell/launch-paths',
  'shell/app-settings',
  'shell/folder-roots',
  'shell/split-memory',
  'shell/window-bounds',
  'shell/app-routing',
  'shell/recent-files',
  'shell/rename-validation',
  'shell/crash-log',
  'shell/crash-heartbeat',
  'electron-utils/atomic-write',
])
const ENGINE_BOUND = [
  'pdf-lib',
  '@embedpdf/pdfium',
  '@neslinesli93/qpdf-wasm',
  'opentype.js',
  'node-forge',
  'officecrypto-tool',
  'cfb',
  'utif2',
  'pngjs',
  'jszip',
]
const AI =
  /^shell\/(agent|mcp|mcp-client|user-skills|generate)\/$|\/ai-|^shell\/knowledge-base$|-ai-|ai-run/
type Batch = 'B1' | 'B2' | 'B3' | 'B4' | 'B5' | 'B6' | 'E' | 'S3'
function batchOf(m: Module): Batch {
  if (B1.has(m.id)) return 'B1'
  if (AI.test(m.id)) return 'B5'
  if (m.ipc.length > 0 || /-main$|^shell\/index$/.test(m.id)) return 'S3'
  if (m.npm.some((p) => ENGINE_BOUND.includes(p))) return 'E'
  const direct = m.electron.length > 0
  if (m.app === 'electron-utils') return direct ? 'B6' : 'B2'
  if (direct) return 'B6'
  return m.app === 'shell' ? 'B3' : 'B4'
}
const batches: Record<
  string,
  { modules: number; lines: number; ipc: number; electronFree: number; ids: string[] }
> = {}
for (const m of modules) {
  const b = (batches[batchOf(m)] ??= { modules: 0, lines: 0, ipc: 0, electronFree: 0, ids: [] })
  b.modules++
  b.lines += m.lines
  b.ipc += m.ipc.length
  if (m.electronFree) b.electronFree += m.lines
  b.ids.push(m.id)
}

const out = join(tool, 'out')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'inventory.json'), `${JSON.stringify(modules, null, 2)}\n`)

const sum = (ms: Module[]): number => ms.reduce((n, m) => n + m.lines, 0)
const summary = {
  modules: modules.length,
  lines: sum(modules),
  perApp: Object.fromEntries(
    [...new Set(modules.map((m) => m.app))].map((app) => {
      const ms = modules.filter((m) => m.app === app)
      return [
        app,
        {
          modules: ms.length,
          lines: sum(ms),
          electronFreeLines: sum(ms.filter((m) => m.electronFree)),
        },
      ]
    }),
  ),
  electronFree: {
    modules: modules.filter((m) => m.electronFree).length,
    lines: sum(modules.filter((m) => m.electronFree)),
  },
  ipcChannels: modules.reduce((n, m) => n + m.ipc.length, 0),
  native: [...new Set(modules.flatMap((m) => m.native))].sort(),
  electronApis: Object.entries(
    modules
      .flatMap((m) => m.electron)
      .reduce<Record<string, number>>((acc, api) => {
        acc[api] = (acc[api] ?? 0) + 1
        return acc
      }, {}),
  ).sort((a, b) => b[1] - a[1]),
}
writeFileSync(join(out, 'batches.json'), `${JSON.stringify(batches, null, 2)}\n`)
writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify(summary, null, 2))
for (const [name, b] of Object.entries(batches).sort()) {
  console.log(
    `${name}: ${b.modules} modules, ${b.lines} lines, ${b.electronFree} Electron-free, ${b.ipc} IPC`,
  )
}

if (process.argv.includes('--markdown')) {
  console.log(
    '\n| 모듈 | 묶음 | 줄 | Electron API | IPC | 파일·OS | npm(네이티브) | Electron 없음 |',
  )
  console.log('| --- | --- | ---: | --- | ---: | --- | --- | :---: |')
  for (const m of modules) {
    const npm = m.npm.map((p) => (m.native.includes(p) ? `${p}*` : p)).join(', ')
    console.log(
      `| \`${m.id}\` | ${batchOf(m)} | ${m.lines} | ${m.electron.join(', ')} | ${m.ipc.length} | ${m.node.join(', ')} | ${npm} | ${m.electronFree ? 'O' : ''} |`,
    )
  }
}
