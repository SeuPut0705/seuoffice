// The manifest of the docx-engine binding: every export of the frozen TypeScript
// engine (tools/docx-diff/reference), who needs it from outside the package,
// and the Rust port that answers it. The generator (gen.ts) reads the JSON this
// writes; nothing else decides what is a binding.
//
//   npx tsx tools/docx-diff/binding/manifest.ts [--out FILE]
//
// Written by a script, never by hand: a hand decision lives in overrides.ts.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { ROOT, config } from './config'

export { ROOT }
export const REFERENCE = join(ROOT, config.reference)
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]!
  : join(ROOT, config.manifest)

// ---------------------------------------------------------------- TypeScript side

export interface ParamInfo {
  name: string
  type: string
  optional: boolean
  rest: boolean
  /** how the value crosses: see engine.ts */
  codec: 'json' | 'xnode' | 'zip' | 'callback' | 'date' | 'bytes'
}

export interface Shape {
  /** map | set | arr | tuple | obj | rec */
  k: string
  /** an array whose holes are undefined */
  u?: true
  v?: Shape
  items?: Array<Shape | null>
  f?: Record<string, Shape>
}

export interface RustInfo {
  /** the path of the function from office-wasm, e.g. docx_engine::font_table::parse_font_table */
  path: string
  file: string
  name: string
  vis: string
  params: string[]
  ret: string
  /** every `mod` of the path is `pub` */
  reachable: boolean
}

export interface ExportInfo {
  module: string
  name: string
  kind: 'function' | 'const' | 'class' | 'type' | 'enum'
  async: boolean
  params: ParamInfo[]
  ret: { type: string; null: boolean; undef: boolean; shape: Shape | null; bytes: boolean }
  /** why the package keeps it: index, subpath, test, package, tool */
  required: string[]
  rust: RustInfo | null
  /** table: a generated row; routes: a hand route of invoke::routes; command: a dedicated blob command; hand: a hand wrapper; ts: stays TypeScript */
  route: 'table' | 'routes' | 'command' | 'hand' | 'ts' | 'none'
  /** what stops it from being a row, when it stays TypeScript */
  reason?: string
  /** a remark on a routed export */
  note?: string
}

function typescriptProgram(): { program: ts.Program; files: string[] } {
  const files = readdirSync(REFERENCE)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(REFERENCE, f))
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: ['node'],
    typeRoots: [join(ROOT, 'node_modules/@types')],
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    esModuleInterop: true,
    allowJs: false,
  }
  return { program: ts.createProgram(files, options), files }
}

function nameOfSymbol(type: ts.Type): string {
  return type.aliasSymbol?.getName() ?? type.getSymbol()?.getName() ?? ''
}

function shapeOf(
  checker: ts.TypeChecker,
  type: ts.Type,
  depth: number,
  stack: Set<number>,
): Shape | null {
  if (depth > 7) return null
  if (type.isUnion()) {
    for (const member of type.types) {
      if (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) continue
      const shape = shapeOf(checker, member, depth, stack)
      if (shape) return shape
    }
    return null
  }
  if (type.isIntersection()) {
    const fields: Record<string, Shape> = {}
    for (const member of type.types) {
      const shape = shapeOf(checker, member, depth, stack)
      if (shape?.k === 'obj') Object.assign(fields, shape.f)
      else if (shape) return shape
    }
    return Object.keys(fields).length ? { k: 'obj', f: fields } : null
  }
  const name = nameOfSymbol(type)
  const args = checker.getTypeArguments(type as ts.TypeReference)
  if (name === 'Map' || name === 'ReadonlyMap')
    return {
      k: 'map',
      ...(args[1] && shapeOf(checker, args[1], depth + 1, stack)
        ? { v: shapeOf(checker, args[1], depth + 1, stack)! }
        : {}),
    }
  if (name === 'Set' || name === 'ReadonlySet') return { k: 'set' }
  if (name === 'Uint8Array' || name === 'ArrayBuffer') return null
  const id = (type as unknown as { id: number }).id
  if (stack.has(id)) return null
  stack.add(id)
  try {
    if (checker.isArrayType(type)) {
      const element = checker.getTypeArguments(type as ts.TypeReference)[0]!
      const item = shapeOf(checker, element, depth + 1, stack)
      // `Array<X | undefined>`: JSON writes the holes as null, the TypeScript held undefined
      const holes =
        element.isUnion() &&
        element.types.some((t) => t.flags & ts.TypeFlags.Undefined) &&
        !element.types.some((t) => t.flags & ts.TypeFlags.Null)
      if (!item && !holes) return null
      return { k: 'arr', ...(holes ? { u: true } : {}), ...(item ? { v: item } : {}) }
    }
    if (checker.isTupleType(type)) {
      const items = checker
        .getTypeArguments(type as ts.TypeReference)
        .map((t) => shapeOf(checker, t, depth + 1, stack))
      return items.some(Boolean) ? { k: 'tuple', items } : null
    }
    if (type.flags & ts.TypeFlags.Object) {
      const fields: Record<string, Shape> = {}
      for (const prop of checker.getPropertiesOfType(type)) {
        const decl = prop.valueDeclaration ?? prop.declarations?.[0]
        if (!decl) continue
        const shape = shapeOf(
          checker,
          checker.getTypeOfSymbolAtLocation(prop, decl),
          depth + 1,
          stack,
        )
        if (shape) fields[prop.getName()] = shape
      }
      const index = checker.getIndexInfoOfType(type, ts.IndexKind.String)
      if (index) {
        const shape = shapeOf(checker, index.type, depth + 1, stack)
        if (shape && !Object.keys(fields).length) return { k: 'rec', v: shape }
      }
      return Object.keys(fields).length ? { k: 'obj', f: fields } : null
    }
    return null
  } finally {
    stack.delete(id)
  }
}

function codecOf(type: string): ParamInfo['codec'] {
  if (/JSZip/.test(type)) return 'zip'
  if (/=>/.test(type) && !/^\{/.test(type.trim())) return 'callback'
  if (/\bDate\b/.test(type)) return 'date'
  if (
    /^(?:Uint8Array|ArrayBuffer|Buffer)(?:<[^>]*>)?$/.test(
      type.replace(/\s*\|\s*undefined/g, ''),
    ) ||
    /^ArrayBuffer \| Uint8Array/.test(type)
  )
    return 'bytes'
  if (/\bXNode\b/.test(type) && !/\[\]/.test(type)) return 'xnode'
  return 'json'
}

/** a printed type with the checkout's own path left out: the manifest is the same in every worktree */
const repoRelative = (type: string): string => type.split(`${ROOT}/`).join('')

function typescriptExports(): ExportInfo[] {
  const { program, files } = typescriptProgram()
  const checker = program.getTypeChecker()
  const out: ExportInfo[] = []
  for (const file of files) {
    const source = program.getSourceFile(file)!
    const moduleSymbol = checker.getSymbolAtLocation(source)
    if (!moduleSymbol) continue
    const module = relative(REFERENCE, file).replace(/\\/g, '/').replace(/\.ts$/, '')
    for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
      const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
      const decl = target.declarations?.[0]
      if (
        !decl ||
        relative(REFERENCE, decl.getSourceFile().fileName).replace(/\\/g, '/') !==
          relative(REFERENCE, file).replace(/\\/g, '/')
      )
        continue
      const flags = target.flags
      const kind: ExportInfo['kind'] =
        flags & ts.SymbolFlags.Function
          ? 'function'
          : flags & ts.SymbolFlags.Class
            ? 'class'
            : flags & ts.SymbolFlags.Variable
              ? 'const'
              : flags & ts.SymbolFlags.Enum
                ? 'enum'
                : 'type'
      const info: ExportInfo = {
        module,
        name: symbol.getName(),
        kind,
        async: false,
        params: [],
        ret: { type: '', null: false, undef: false, shape: null, bytes: false },
        required: [],
        rust: null,
        route: 'none',
      }
      if (kind === 'function') {
        const signatures = checker.getTypeOfSymbolAtLocation(target, decl).getCallSignatures()
        const signature = signatures[0]
        if (signature) {
          info.params = signature.getParameters().map((p) => {
            const d = p.valueDeclaration as ts.ParameterDeclaration | undefined
            const type = repoRelative(
              checker.typeToString(
                checker.getTypeOfSymbolAtLocation(p, decl),
                decl,
                ts.TypeFormatFlags.NoTruncation,
              ),
            )
            return {
              name: p.getName(),
              type,
              optional: !!(d && (d.questionToken || d.initializer)),
              rest: !!d?.dotDotDotToken,
              codec: codecOf(type),
            }
          })
          let returned = signature.getReturnType()
          const returnedName = nameOfSymbol(returned)
          const promised = returnedName === 'Promise'
          if (promised)
            returned = checker.getTypeArguments(returned as ts.TypeReference)[0] ?? returned
          info.async =
            promised ||
            !!(ts.getCombinedModifierFlags(decl as ts.Declaration) & ts.ModifierFlags.Async)
          const members = returned.isUnion() ? returned.types : [returned]
          info.ret = {
            type: repoRelative(
              checker.typeToString(returned, decl, ts.TypeFormatFlags.NoTruncation),
            ).slice(0, 300),
            null: members.some((m) => m.flags & ts.TypeFlags.Null),
            undef: members.some((m) => m.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)),
            shape: shapeOf(checker, returned, 0, new Set()),
            bytes: /Uint8Array/.test(checker.typeToString(returned, decl)),
          }
        }
      }
      out.push(info)
    }
  }
  return out
}

// ---------------------------------------------------------------- who needs an export

function rg(pattern: string, dirs: string[]): string[] {
  try {
    return execFileSync(
      'rg',
      [
        '-l',
        '--no-messages',
        '-g',
        '*.ts',
        '-g',
        '*.tsx',
        '-g',
        '*.mjs',
        '-g',
        '*.mts',
        '-g',
        '!**/node_modules/**',
        '-g',
        '!**/dist/**',
        '-g',
        `!${config.reference}/**`,
        pattern,
        ...dirs,
      ],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 },
    )
      .split('\n')
      .filter(Boolean)
  } catch {
    return []
  }
}

const IMPORT =
  /(?:import|export)\s+(type\s+)?(?:(\*\s+as\s+\w+)|\{([\s\S]*?)\})\s*from\s*['"]([^'"]+)['"]/g
const PACKAGE = config.packageDir.split('/').pop()!
const DYNAMIC = new RegExp(`(?:import|vi\\.mock|vi\\.importActual)\\(\\s*['"]([^'"]*${PACKAGE}[^'"]*)['"]`, 'g')

/** the module a specifier of the package names, 'index' where it names the package index */
function moduleOfSpecifier(specifier: string): string | null {
  let m = new RegExp(`${config.packageName}(?:\\/(.+))?$`).exec(specifier)
  if (m) return m[1] ?? 'index'
  m = new RegExp(`(?:^|\\/)${PACKAGE}\\/(?:src|tests)\\/(.+?)(?:\\.(?:ts|mjs))?$`).exec(specifier)
  if (m) return m[0].includes('/tests/') ? null : m[1]!
  return null
}

function requiredBy(exportsOf: Map<string, ExportInfo[]>): Map<string, Set<string>> {
  const needed = new Map<string, Set<string>>()
  const need = (module: string, name: string, why: string): void => {
    const key = `${module}:${name}`
    if (!needed.has(key)) needed.set(key, new Set())
    needed.get(key)!.add(why)
  }
  const wholeModule = (module: string, why: string): void => {
    for (const e of exportsOf.get(module) ?? []) need(module, e.name, why)
  }
  // the package index and what it re-exports
  const index = readFileSync(join(REFERENCE, 'index.ts'), 'utf8')
  const fromIndex = new Map<string, string[]>()
  for (const m of index.matchAll(IMPORT)) {
    const specifier = m[4]!
    if (!specifier.startsWith('./')) continue
    const module = specifier.slice(2)
    if (m[2]) wholeModule(module, 'index')
    else
      for (const raw of m[3]!.split(',')) {
        const name = raw
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0]!
          .trim()
        if (name) {
          need(module, name, 'index')
          fromIndex.set(module, [...(fromIndex.get(module) ?? []), name])
        }
      }
  }
  // package.json subpaths
  const pkg: { exports: Record<string, unknown> } = JSON.parse(
    readFileSync(join(ROOT, config.packageDir, 'package.json'), 'utf8'),
  )
  const targetsOf = (entry: unknown): string[] =>
    typeof entry === 'string'
      ? [entry]
      : entry && typeof entry === 'object'
        ? Object.values(entry).flatMap(targetsOf)
        : []
  for (const target of Object.values(pkg.exports).flatMap(targetsOf)) {
    const module = target.replace(/^\.\/src\//, '').replace(/\.ts$/, '')
    // the entries of the binding itself (node/, engine-*, init) are not engine modules
    if (!config.pluginModule(module)) wholeModule(module, 'subpath')
  }
  // everything else in the repository that imports a module of the package
  const files = rg(PACKAGE, ['apps', 'packages', 'tools', 'e2e']).filter(
    (f) =>
      !f.startsWith(`${config.packageDir}/src/`) &&
      !f.startsWith(`${config.reference}/`) &&
      !f.startsWith(`${config.bindingDir}/`),
  )
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    const why = file.startsWith(`${config.packageDir}/tests/`)
      ? 'test'
      : file.startsWith('tools/')
        ? 'tool'
        : file.startsWith('apps/') || file.startsWith('packages/')
          ? file.includes('/tests/')
            ? 'test'
            : 'package'
          : 'package'
    for (const m of text.matchAll(IMPORT)) {
      const module = moduleOfSpecifier(m[4]!)
      if (!module) continue
      if (m[2]) wholeModule(module, why)
      else
        for (const raw of m[3]!.split(',')) {
          const name = raw
            .trim()
            .replace(/^type\s+/, '')
            .split(/\s+as\s+/)[0]!
            .trim()
          if (name) need(module, name, why)
        }
    }
    for (const m of text.matchAll(DYNAMIC)) {
      const module = moduleOfSpecifier(m[1]!)
      if (module) wholeModule(module, why)
    }
  }
  // the tests of the package itself import `../src/<module>`
  const tests = join(ROOT, config.packageDir, 'tests')
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) =>
      statSync(join(dir, n)).isDirectory()
        ? walk(join(dir, n))
        : n.endsWith('.ts')
          ? [join(dir, n)]
          : [],
    )
  for (const file of walk(tests)) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(IMPORT)) {
      const specifier = m[4]!
      const hit = /^(?:\.\.\/)+src\/(.+?)(?:\.(?:ts|mjs))?$/.exec(specifier)
      if (!hit) continue
      const module = hit[1]!
      if (m[2]) wholeModule(module, 'test')
      else
        for (const raw of m[3]!.split(',')) {
          const name = raw
            .trim()
            .replace(/^type\s+/, '')
            .split(/\s+as\s+/)[0]!
            .trim()
          if (name) need(module, name, 'test')
        }
    }
    for (const m of text.matchAll(
      /(?:import|vi\.mock|vi\.importActual)\(\s*['"](?:\.\.\/)+src\/([^'"]+?)(?:\.(?:ts|mjs))?['"]/g,
    ))
      wholeModule(m[1]!, 'test')
  }
  return needed
}

// ---------------------------------------------------------------- Rust side

interface RustFn {
  file: string
  name: string
  vis: string
  indent: number
  params: string[]
  ret: string
  doc: string
}

const CRATES = config.crates

function splitTop(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if ('<([{'.includes(c)) depth++
    else if (')]}'.includes(c) || (c === '>' && text[i - 1] !== '-')) depth--
    if (c === ',' && depth === 0) {
      out.push(current)
      current = ''
    } else current += c
  }
  if (current.trim()) out.push(current)
  return out.map((s) => s.trim()).filter(Boolean)
}

function rustFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? rustFiles(p) : n.endsWith('.rs') ? [p] : []
  })
}

function rustFns(): RustFn[] {
  const out: RustFn[] = []
  for (const { dir } of CRATES) {
    for (const file of rustFiles(join(ROOT, dir))) {
      const text = readFileSync(file, 'utf8')
      const lines = text.split('\n')
      for (const m of text.matchAll(
        /^( *)(pub(?:\([a-z]+\))? )?(?:const )?(?:async )?fn ([a-z_0-9]+)(?:<[^>(]*>)?\(/gm,
      )) {
        let i = m.index! + m[0].length - 1
        let depth = 0
        for (; i < text.length; i++) {
          if (text[i] === '(') depth++
          else if (text[i] === ')' && --depth === 0) break
        }
        const params = text.slice(m.index! + m[0].length, i)
        const after = i + 1
        const brace = text.indexOf('{', after)
        const semi = text.indexOf(';', after)
        const end = semi === -1 || (brace !== -1 && brace < semi) ? brace : semi
        let ret = text.slice(after, end).trim()
        ret = ret.startsWith('->') ? ret.slice(2).trim() : ''
        ret = ret.replace(/\s*where[\s\S]*/, '')
        const line = text.slice(0, m.index!).split('\n').length - 1
        const doc: string[] = []
        for (
          let q = line - 1;
          q >= 0 && (lines[q]!.trim().startsWith('///') || lines[q]!.trim().startsWith('#['));
          q--
        )
          if (lines[q]!.trim().startsWith('///')) doc.unshift(lines[q]!.trim().slice(3).trim())
        out.push({
          file: relative(ROOT, file).replace(/\\/g, '/'),
          name: m[3]!,
          vis: (m[2] ?? '').trim(),
          indent: m[1]!.length,
          params: splitTop(params),
          ret,
          doc: doc.join(' '),
        })
      }
    }
  }
  return out
}

const snake = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()

/** the text of the file that declares the module `parts` of a crate: lib.rs, or `<parts>.rs`, or `<parts>/mod.rs` */
function declaringText(crateDir: string, parts: string[]): string {
  const candidates = parts.length
    ? [`${[crateDir, ...parts].join('/')}.rs`, `${[crateDir, ...parts].join('/')}/mod.rs`]
    : [`${crateDir}/lib.rs`]
  return candidates
    .filter((c) => existsSync(join(ROOT, c)))
    .map((c) => readFileSync(join(ROOT, c), 'utf8'))
    .join('\n')
}

/**
 * `a::b::c` of a function of a crate, and whether office-wasm can name it: every
 * `mod` on the way `pub`, or a `pub use` of an ancestor that names it.
 */
export function pathOf(file: string, name: string): { path: string; reachable: boolean } {
  const crate = CRATES.find((c) => file.startsWith(c.dir + '/'))!
  const parts = relative(crate.dir, file).replace(/\\/g, '/').replace(/\.rs$/, '').split('/')
  if (parts.at(-1) === 'mod') parts.pop()
  const publicTo: boolean[] = [] // publicTo[i]: the module parts[0..i] is nameable from outside
  let open = true
  for (let i = 0; i < parts.length; i++) {
    const declared = new RegExp(`^\\s*pub mod ${parts[i]};`, 'm').test(
      declaringText(crate.dir, parts.slice(0, i)),
    )
    open = open && declared
    publicTo.push(open)
  }
  if (open) return { path: [crate.crate, ...parts, name].join('::'), reachable: true }
  // the deepest ancestor that is nameable and re-exports the function
  for (let depth = parts.length - 1; depth >= 0; depth--) {
    if (depth > 0 && !publicTo[depth - 1]) continue
    const text = declaringText(crate.dir, parts.slice(0, depth))
    const reexport = new RegExp(
      `pub use [^;]*\\b${name}\\b[^;]*;|pub use ${parts[depth]}::\\*;`,
      'm',
    )
    if (reexport.test(text))
      return { path: [crate.crate, ...parts.slice(0, depth), name].join('::'), reachable: true }
  }
  return { path: [crate.crate, ...parts, name].join('::'), reachable: false }
}

function rustMatch(fns: RustFn[], ts: ExportInfo): RustInfo | null {
  const mentioned = (f: RustFn): boolean => new RegExp('`' + ts.name + '(?:[`(:]|$)').test(f.doc)
  // the function that is named like the export, else the one whose doc names it
  const named = config.rustName?.(ts.name) ?? snake(ts.name)
  let c = fns.filter((f) => f.indent === 0 && f.name === named)
  if (!c.length) c = fns.filter((f) => f.indent === 0 && mentioned(f))
  // the Rust module of the export's own TypeScript module first
  const own = config.rustModule?.(ts.module)
  if (own && c.length > 1) {
    const there = c.filter((f) => f.file === own || f.file.startsWith(own.replace(/\.rs$/, '/')))
    if (there.length) c = there
  }
  if (c.length > 1) {
    // a module of the TypeScript names its own Rust module first; the save side's external.rs re-declares callees
    const own = c.filter((f) => !f.file.endsWith('/external.rs'))
    if (own.length) c = own
  }
  if (c.length > 1) {
    const exact = c.filter((f) => f.name === named)
    if (exact.length) c = exact
  }
  if (c.length > 1) {
    const open = c.filter((f) => f.vis === 'pub' && pathOf(f.file, f.name).reachable)
    const pub = c.filter((f) => f.vis === 'pub')
    c = open.length ? open : pub.length ? pub : c
  }
  const f = c[0]
  if (!f) return null
  const { path, reachable } = pathOf(f.file, f.name)
  return {
    path,
    file: f.file,
    name: f.name,
    vis: f.vis,
    params: f.params.filter((p) => !/^&?(?:mut )?self$/.test(p)),
    ret: f.ret,
    reachable,
  }
}

// ---------------------------------------------------------------- the manifest

/** The wire arguments of the engine call a body spells (`$call(a, b)`); undefined where it has no explicit call. */
function callArity(body: string | undefined): number | undefined {
  const at = body?.indexOf('$call(') ?? -1
  if (!body || at === -1) return undefined
  let depth = 0
  let count = 0
  let any = false
  for (let i = at + '$call'.length; i < body.length; i++) {
    const c = body[i]!
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c) && --depth === 0) break
    else if (c === ',' && depth === 1) count++
    else if (depth >= 1 && !/\s/.test(c)) any = true
  }
  return any ? count + 1 : 0
}

export function build(): { exports: ExportInfo[] } {
  const exports = typescriptExports()
  const byModule = new Map<string, ExportInfo[]>()
  for (const e of exports) byModule.set(e.module, [...(byModule.get(e.module) ?? []), e])
  const needed = requiredBy(byModule)
  const fns = rustFns()
  // a name asked for through a re-exporting module is required of the module that declares it
  const declared = new Map<string, ExportInfo[]>()
  for (const e of exports) declared.set(e.name, [...(declared.get(e.name) ?? []), e])
  for (const [key, why] of needed) {
    const [module, name] = key.split(':') as [string, string]
    if (byModule.get(module)?.some((e) => e.name === name)) continue
    for (const e of declared.get(name) ?? [])
      for (const reason of why)
        needed.get(`${e.module}:${e.name}`)?.add(reason) ??
          needed.set(`${e.module}:${e.name}`, new Set([reason]))
  }
  for (const e of exports) {
    e.required = [...(needed.get(`${e.module}:${e.name}`) ?? [])].sort()
    if (e.kind !== 'function') continue
    e.rust = rustMatch(fns, e)
    const override = config.overrideOf(e.name)
    const wire = e.rust ? config.wireParams(e.rust.params) : []
    if (config.hostModules[e.module]) {
      e.route = 'ts'
      e.reason = 'a module of the host side of the package: it stays TypeScript and engine-free'
    } else if (override?.reject) {
      e.route = 'ts'
      e.reason = override.reject
    } else if (override?.command) e.route = 'command'
    else if (override?.hand) e.route = 'hand'
    else if (config.isHandRoute(e.name)) e.route = 'routes'
    else if (!e.rust) {
      e.route = 'ts'
      e.reason = 'no Rust port names it'
    } else if (!e.rust.reachable || e.rust.vis !== 'pub') {
      e.route = 'ts'
      e.reason = `the port is not public (${e.rust.vis || 'private'}, ${e.rust.reachable ? 'reachable' : 'in a private module'}): ${e.rust.path}`
    } else if (
      !override?.rust &&
      !config.ownRow?.(override) &&
      (!wire.every(config.decodable) || /&mut|dyn |impl /.test(e.rust.ret))
    ) {
      e.route = 'ts'
      e.reason = `its Rust signature is not one a row can read: (${e.rust.params.join(', ')}) -> ${e.rust.ret}`
    } else if (
      !override?.rust &&
      wire.length !== (override?.args?.length ?? callArity(override?.body) ?? e.params.length)
    ) {
      e.route = 'ts'
      e.reason = `arity differs: TypeScript ${e.params.length} (${e.params.map((p) => p.name).join(', ')}), Rust ${wire.length}`
    } else e.route = 'table'
    if (e.route === 'table' && config.dropUnused && !e.required.length)
      e.note = 'nothing outside the package uses it: the module drops it unless a kept piece names it'
  }
  return { exports }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = build()
  writeFileSync(OUT, JSON.stringify(manifest, null, 1) + '\n')
  const fnsOnly = manifest.exports.filter((e) => e.kind === 'function')
  const tally = new Map<string, number>()
  for (const e of fnsOnly) tally.set(e.route, (tally.get(e.route) ?? 0) + 1)
  console.log(
    `${manifest.exports.length} exports, ${fnsOnly.length} functions:`,
    Object.fromEntries(tally),
  )
  const needed = fnsOnly.filter((e) => e.required.length)
  const stay = needed.filter((e) => e.route === 'ts' || e.route === 'none')
  console.log(
    `${needed.length} functions are needed from outside; ${stay.length} of them stay TypeScript:`,
  )
  for (const e of stay)
    console.log(`  ${e.module}.${e.name} [${e.required.join(',')}]: ${e.reason ?? ''}`)
}
