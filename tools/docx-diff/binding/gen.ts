// The generator of the docx-engine binding. From the frozen TypeScript engine
// (tools/docx-diff/reference) and the manifest it writes
//   1. packages/docx-engine/src/<module>.ts: each module that has an export the
//      engine answers keeps its exported names and types, the answered functions
//      become one-line calls of the engine (engine.ts), and what nothing needs
//      any more is dropped;
//   2. crates/office-wasm/src/invoke/table.rs: the table `invoke` answers them by.
// It is a tool, not a check: it overwrites its output and refuses to touch what
// the switch plumbing owns (src/node/**, src/engine-*.ts, src/vendor/**) but
// the shape tables it writes itself (engine-shapes.ts, engine-type-shapes.ts).
//
//   npx tsx tools/docx-diff/binding/gen.ts [--engine docx|pptx] [--dry]
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as prettier from 'prettier'
import ts from 'typescript'
import { config } from './config'
import { type ExportInfo, REFERENCE, ROOT, build, writeManifest } from './manifest'
import type { Override } from './overrides'
import { rustTable } from './rust-table'

const overrideOf = config.overrideOf
const SRC = join(ROOT, config.packageDir, 'src')
const DRY = process.argv.includes('--dry')

const routed = (e: ExportInfo): boolean =>
  e.route === 'table' || e.route === 'routes' || e.route === 'hand' || e.route === 'command'

// ---------------------------------------------------------------- the TypeScript modules

interface Import {
  local: string
  imported: string
  kind: 'named' | 'default' | 'namespace'
  typeOnly: boolean
}

interface ImportDecl {
  spec: string
  imports: Import[]
  clauseTypeOnly: boolean
  sideEffect: boolean
}

interface Piece {
  module: string
  names: string[]
  exported: boolean
  typeLike: boolean
  root: boolean
  /** the statement with its leading comments, a routed function with its body replaced */
  text: string
  refs: Set<string>
  /** the routed function this piece is, whose body was replaced */
  wrapped: ExportInfo | null
  /** the piece's text is the config's hand-written replacement */
  replaced: boolean
  /** what a re-export names of another module: its names, or '*' */
  reexports: Array<{ target: string; name: string }>
}

interface Module {
  name: string
  header: string
  imports: ImportDecl[]
  pieces: Piece[]
}

function identifiersOf(
  node: ts.Node,
  into: Set<string>,
  shadowed: ReadonlySet<string> = new Set(),
): Set<string> {
  if (ts.isIdentifier(node) && !shadowed.has(node.text)) into.add(node.text)
  // a parameter shadows a module-level name spelled alike, in the function that declares it
  let inner = shadowed
  if (config.dropReexportRefs && ts.isFunctionLike(node) && node.parameters.length) {
    const names = new Set(shadowed)
    for (const parameter of node.parameters)
      bindingNames(parameter.name, []).forEach((name) => names.add(name))
    inner = names
  }
  ts.forEachChild(node, (child) => {
    if (config.dropReexportRefs && ts.isParameter(node) && child === node.name) return
    identifiersOf(child, into, inner)
  })
  return into
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === kind)
}

function bindingNames(name: ts.BindingName, into: string[]): string[] {
  if (ts.isIdentifier(name)) into.push(name.text)
  else
    for (const element of name.elements)
      if (!ts.isOmittedExpression(element)) bindingNames(element.name, into)
  return into
}

const NOW = { $now: 'Date.now()', $nowIso: 'new Date().toISOString()' }

/** The body of a routed function: what it hands the engine. Null where the declaration cannot be rewritten. */
function wrapperBody(
  info: ExportInfo,
  fn: ts.FunctionDeclaration,
  override: Override | undefined,
): string | null {
  const params = fn.parameters
  if (!config.wrapperBody && params.some((p) => !ts.isIdentifier(p.name)))
    return override?.body ?? null
  // a destructured parameter is passed whole, under the name `argN` that the signature is rewritten to
  const names = params.map((p, i) => (ts.isIdentifier(p.name) ? p.name.text : `arg${i}`))
  if (config.wrapperBody) return config.wrapperBody(info, names, override)
  if (override?.body) return override.body
  if (info.route === 'command' || info.route === 'hand') {
    return `return hand.${info.name}(${params.map((p, i) => (p.dotDotDotToken ? '...' : '') + names[i]).join(', ')}) as never`
  }
  const zipAt = info.params.findIndex((p) => p.codec === 'zip')
  const expr = (i: number): string => {
    const p = info.params[i]!
    const name = names[i]!
    if (p.rest) return `...${name}`
    return p.codec === 'xnode' ? `xnodeArg(${name})` : name
  }
  let args: string[] =
    override?.args?.map((a) => NOW[a as keyof typeof NOW] ?? a) ??
    info.params.map((_, i) => expr(i))
  const options: string[] = []
  if (
    override?.callbacks ||
    info.params.some(
      (p) => p.codec === 'callback' || /=>/.test(p.type) || /GenerateContext/.test(p.type),
    )
  )
    options.push(`names: ${JSON.stringify(names)}`)
  if (info.ret.shape) options.push(`shape: ${JSON.stringify(info.ret.shape)}`)
  if (info.ret.undef && !info.ret.null) options.push('undef: true')
  const tail = options.length ? `, { ${options.join(', ')} }` : ''
  if (zipAt >= 0) {
    if (zipAt !== 0) return null
    const mutates = !!info.rust?.params.some((p) => /&mut\s+Package/.test(p))
    args = args.slice(1)
    return `return zipCall('${info.name}', ${names[0]}, [${args.join(', ')}], ${mutates}${tail}) as never`
  }
  return `return ${info.async ? 'invokeAsync' : 'invoke'}('${info.name}', [${args.join(', ')}]${tail}) as never`
}

const OVERRIDES_KEEP_INFERRED: ReadonlySet<string> = new Set()

/** A type the checker printed with `import("…/reference/<module>").Name` paths, as a name this module imports. */
function spellType(type: string, module: string, mod: Module): string {
  return type.replace(
    /import\("[^"]*?\/reference\/([\w-]+)"\)\.(\w+)/g,
    (_match, from: string, name: string) => {
      const known = mod.imports.some((d) => d.imports.some((i) => i.local === name))
      if (!known && from !== module)
        mod.imports.push({
          spec: `./${from}`,
          clauseTypeOnly: true,
          sideEffect: false,
          imports: [{ local: name, imported: name, kind: 'named', typeOnly: false }],
        })
      return name
    },
  )
}

function parseModule(name: string, infoByName: Map<string, ExportInfo>): Module {
  const file = join(REFERENCE, `${name}.ts`)
  const text = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const statements = [...sf.statements]
  const mod: Module = { name, header: '', imports: [], pieces: [] }
  const firstStart = statements[0]?.getStart(sf, false) ?? text.length
  mod.header = text.slice(0, firstStart).trimEnd()
  for (const stmt of statements) {
    if (ts.isImportDeclaration(stmt)) {
      const clause = stmt.importClause
      const decl: ImportDecl = {
        spec: (stmt.moduleSpecifier as ts.StringLiteral).text,
        imports: [],
        clauseTypeOnly: !!clause?.isTypeOnly,
        sideEffect: !clause,
      }
      if (clause?.name)
        decl.imports.push({
          local: clause.name.text,
          imported: 'default',
          kind: 'default',
          typeOnly: false,
        })
      const bindings = clause?.namedBindings
      if (bindings && ts.isNamespaceImport(bindings))
        decl.imports.push({
          local: bindings.name.text,
          imported: '*',
          kind: 'namespace',
          typeOnly: false,
        })
      else if (bindings)
        for (const el of bindings.elements)
          decl.imports.push({
            local: el.name.text,
            imported: (el.propertyName ?? el.name).text,
            kind: 'named',
            typeOnly: el.isTypeOnly,
          })
      mod.imports.push(decl)
      continue
    }
    const exported = hasModifier(stmt, ts.SyntaxKind.ExportKeyword)
    const piece: Piece = {
      module: name,
      names: [],
      exported,
      typeLike: false,
      root: false,
      text: stmt.getFullText(sf),
      refs: new Set(),
      wrapped: null,
      replaced: false,
      reexports: [],
    }
    if (ts.isFunctionDeclaration(stmt)) {
      if (stmt.name) piece.names.push(stmt.name.text)
      const info = stmt.name && stmt.body ? infoByName.get(stmt.name.text) : undefined
      if (info && (routed(info) || overrideOf(info.name)?.body) && stmt.body) {
        const body = wrapperBody(info, stmt, overrideOf(info.name))
        if (body === null)
          throw new Error(`${name}.${info.name}: a parameter of this function is not a plain name`)
        let prefix = text.slice(stmt.getFullStart(), stmt.body.getStart(sf))
        if (stmt.parameters.some((p) => !ts.isIdentifier(p.name))) {
          const first = stmt.parameters[0]!
          const last = stmt.parameters[stmt.parameters.length - 1]!
          const named = stmt.parameters.map((p, i) =>
            ts.isIdentifier(p.name)
              ? p.getText(sf)
              : `arg${i}${p.questionToken ? '?' : ''}${p.type ? `: ${p.type.getText(sf)}` : ''}`,
          )
          prefix = `${text.slice(stmt.getFullStart(), first.getStart(sf))}${named.join(', ')}${text.slice(last.getEnd(), stmt.body.getStart(sf))}`
        } else {
          // a parameter the engine owns (a ContentControlPart) is not sent: named as unused
          for (const param of [...stmt.parameters].reverse()) {
            const id = param.name as ts.Identifier
            if (new RegExp(`\\b${id.text}\\b`).test(body)) continue
            const at = id.getStart(sf) - stmt.getFullStart()
            prefix = `${prefix.slice(0, at)}_${prefix.slice(at)}`
          }
        }
        if (!stmt.type && !OVERRIDES_KEEP_INFERRED.has(info.name)) {
          // the declared type of a function that infers it: spelled out, as the wrapper's `as never` has none
          const spelled = spellType(info.ret.type, name, mod)
          prefix = `${prefix.trimEnd()}: ${info.async ? `Promise<${spelled}>` : spelled} `
        }
        piece.text = `${prefix}{\n  ${body}\n}`
        piece.wrapped = info
      }
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) bindingNames(d.name, piece.names)
    } else if (ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
      if (stmt.name) piece.names.push(stmt.name.text)
    } else if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) {
      piece.names.push(stmt.name.text)
      piece.typeLike = true
    } else if (ts.isModuleDeclaration(stmt)) {
      piece.names.push(stmt.name.text)
    } else {
      // an expression, an export list, a re-export: kept, with what it names
      piece.root = true
      if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier) {
        const target = moduleOf((stmt.moduleSpecifier as ts.StringLiteral).text)
        if (target) {
          if (stmt.exportClause && ts.isNamedExports(stmt.exportClause))
            for (const el of stmt.exportClause.elements)
              piece.reexports.push({ target, name: (el.propertyName ?? el.name).text })
          else piece.reexports.push({ target, name: '*' })
        }
      }
    }
    const replacement = piece.names
      .map((n) => config.replace[name]?.[n])
      .find((text) => text !== undefined)
    if (replacement !== undefined) {
      piece.text = `${text.slice(stmt.getFullStart(), stmt.getStart(sf))}${replacement}`
      piece.replaced = true
    }
    if (piece.wrapped || piece.replaced) {
      const probe = ts.createSourceFile('wrapper.ts', piece.text, ts.ScriptTarget.ES2022, true)
      identifiersOf(probe, piece.refs)
      // a parameter shadows an import of its name inside the wrapper (withheldText's `textOf`)
      if (ts.isFunctionDeclaration(stmt))
        for (const param of stmt.parameters)
          if (ts.isIdentifier(param.name)) piece.refs.delete(param.name.text)
    } else if (!(ts.isExportDeclaration(stmt) && stmt.moduleSpecifier))
      identifiersOf(stmt, piece.refs)
    // an `export { x } from '…'` names x in another module, not this one's import of it
    mod.pieces.push(piece)
  }
  return mod
}

function moduleOf(spec: string): string | null {
  const m = /^\.\/([^/]+)$/.exec(spec)
  return m ? m[1]! : null
}

/** the text of an import declaration with only the bindings in `used` */
function importText(decl: ImportDecl, used: Set<string>): string | null {
  if (decl.sideEffect) return `import '${decl.spec}'`
  const keep = decl.imports.filter((i) => used.has(i.local))
  if (!keep.length) return null
  const type = decl.clauseTypeOnly ? 'type ' : ''
  const parts: string[] = []
  const def = keep.find((i) => i.kind === 'default')
  const ns = keep.find((i) => i.kind === 'namespace')
  if (def) parts.push(def.local)
  if (ns) parts.push(`* as ${ns.local}`)
  const named = keep
    .filter((i) => i.kind === 'named')
    .map(
      (i) =>
        `${i.typeOnly ? 'type ' : ''}${i.imported === i.local ? i.local : `${i.imported} as ${i.local}`}`,
    )
  if (named.length) parts.push(`{ ${named.join(', ')} }`)
  return `import ${type}${parts.join(', ')} from '${decl.spec}'`
}

interface Output {
  module: string
  text: string
}

function generateModules(exportsAll: ExportInfo[]): {
  outputs: Output[]
  verbatim: string[]
  dropped: string[]
  wrapped: Set<string>
} {
  const byModule = new Map<string, ExportInfo[]>()
  for (const e of exportsAll) byModule.set(e.module, [...(byModule.get(e.module) ?? []), e])
  const rewritten = [...byModule.entries()]
    .filter(([, list]) => list.some((e) => e.kind === 'function' && routed(e)))
    .map(([name]) => name)
  const everyModule = readdirSync(REFERENCE)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.replace(/\.ts$/, ''))
  const verbatim = everyModule.filter(
    (m) => !rewritten.includes(m) && !Object.hasOwn(config.unusedModules ?? {}, m),
  )

  const mods = new Map<string, Module>()
  for (const name of rewritten) {
    const infoByName = new Map(
      (byModule.get(name) ?? []).filter((e) => e.kind === 'function').map((e) => [e.name, e]),
    )
    mods.set(name, parseModule(name, infoByName))
  }

  // the names each module is asked for: its required exports, and what the modules kept as they are import from it
  const keep = new Set<Piece>()
  const queue: Piece[] = []
  const take = (piece: Piece): void => {
    if (!keep.has(piece)) {
      keep.add(piece)
      queue.push(piece)
    }
  }
  const takeName = (module: string, name: string): void => {
    for (const piece of mods.get(module)?.pieces ?? []) if (piece.names.includes(name)) take(piece)
  }
  const takeAll = (module: string): void => {
    for (const piece of mods.get(module)?.pieces ?? []) if (piece.exported) take(piece)
  }
  for (const mod of mods.values()) {
    const required = new Set(
      (byModule.get(mod.name) ?? []).filter((e) => e.required.length).map((e) => e.name),
    )
    for (const piece of mod.pieces) {
      if (
        piece.root ||
        (piece.exported && (piece.typeLike || piece.names.some((n) => required.has(n))))
      )
        take(piece)
    }
  }
  const importsOfVerbatim = (module: string): ImportDecl[] => {
    const file = join(REFERENCE, `${module}.ts`)
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true)
    const out: ImportDecl[] = []
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && stmt.importClause) {
        const clause = stmt.importClause
        const decl: ImportDecl = {
          spec: (stmt.moduleSpecifier as ts.StringLiteral).text,
          imports: [],
          clauseTypeOnly: !!clause.isTypeOnly,
          sideEffect: false,
        }
        if (clause.name)
          decl.imports.push({
            local: clause.name.text,
            imported: 'default',
            kind: 'default',
            typeOnly: false,
          })
        const b = clause.namedBindings
        if (b && ts.isNamespaceImport(b))
          decl.imports.push({
            local: b.name.text,
            imported: '*',
            kind: 'namespace',
            typeOnly: false,
          })
        else if (b)
          for (const el of b.elements)
            decl.imports.push({
              local: el.name.text,
              imported: (el.propertyName ?? el.name).text,
              kind: 'named',
              typeOnly: el.isTypeOnly,
            })
        out.push(decl)
      } else if (
        (ts.isExportDeclaration(stmt) || ts.isImportDeclaration(stmt)) &&
        stmt.moduleSpecifier
      ) {
        const spec = (stmt.moduleSpecifier as ts.StringLiteral).text
        const target = moduleOf(spec)
        if (target && mods.has(target)) {
          if (
            ts.isExportDeclaration(stmt) &&
            stmt.exportClause &&
            ts.isNamedExports(stmt.exportClause)
          )
            for (const el of stmt.exportClause.elements)
              takeName(target, (el.propertyName ?? el.name).text)
          else takeAll(target)
        }
      }
    }
    return out
  }
  for (const module of verbatim) {
    for (const decl of importsOfVerbatim(module)) {
      const target = moduleOf(decl.spec)
      if (!target || !mods.has(target)) continue
      for (const i of decl.imports) {
        if (i.kind === 'namespace') takeAll(target)
        else takeName(target, i.imported)
      }
    }
  }
  // what a kept piece names
  while (queue.length) {
    const piece = queue.pop()!
    const mod = mods.get(piece.module)!
    for (const { target, name } of piece.reexports) {
      if (!mods.has(target)) continue
      if (name === '*') takeAll(target)
      else takeName(target, name)
    }
    for (const ref of piece.refs) {
      for (const other of mod.pieces) if (other.names.includes(ref)) take(other)
      for (const decl of mod.imports) {
        const target = moduleOf(decl.spec)
        for (const i of decl.imports) {
          if (i.local !== ref || !target || !mods.has(target)) continue
          if (i.kind === 'namespace') takeAll(target)
          else takeName(target, i.imported)
        }
      }
    }
  }

  const outputs: Output[] = []
  const dropped: string[] = []
  const wrapped = new Set<string>()
  for (const mod of mods.values()) {
    const kept = mod.pieces.filter((p) => keep.has(p))
    for (const piece of kept) if (piece.wrapped) wrapped.add(piece.wrapped.name)
    if (!kept.length) {
      dropped.push(mod.name)
      continue
    }
    const used = new Set<string>()
    for (const piece of kept) for (const ref of piece.refs) used.add(ref)
    const lines: string[] = []
    for (const decl of mod.imports) {
      const line = importText(decl, used)
      if (line) lines.push(line)
    }
    const wrappers = kept
      .filter((p) => p.wrapped || p.replaced)
      .map((p) => p.text)
      .join('\n')
    if (config.coreImports) lines.push(...config.coreImports(wrappers))
    else {
      const core = ['invoke', 'invokeAsync', 'xnodeArg', 'zipCall'].filter((n) =>
        new RegExp(`\\b${n}\\(`).test(wrappers),
      )
      const fromEngine = core.filter((n) => n !== 'zipCall')
      if (fromEngine.length) lines.push(`import { ${fromEngine.join(', ')} } from './engine'`)
      if (core.includes('zipCall')) lines.push(`import { zipCall } from './engine-hand'`)
      if (/\bhand\./.test(wrappers)) lines.push(`import * as hand from './engine-hand'`)
    }
    const body = kept.map((p) => p.text.replace(/^\n+/, '\n')).join('')
    const append = config.append[mod.name] ? `\n${config.append[mod.name]}\n` : ''
    const header = mod.header ? `${mod.header}\n` : ''
    outputs.push({
      module: mod.name,
      text: `${header}${lines.join('\n')}\n${body.replace(/^\n*/, '\n')}${append}`,
    })
  }
  dropped.push(...Object.keys(config.unusedModules ?? {}))
  return { outputs, verbatim, dropped, wrapped }
}

// ---------------------------------------------------------------- the generator's own consistency check

/** The names a module exports, and whether it re-exports another module whole. */
function exportsOfText(file: string, text: string): { names: Set<string>; stars: string[] } {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true)
  const names = new Set<string>()
  const stars: string[] = []
  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt)) {
      if (!stmt.exportClause && stmt.moduleSpecifier)
        stars.push((stmt.moduleSpecifier as ts.StringLiteral).text)
      else if (stmt.exportClause && ts.isNamedExports(stmt.exportClause))
        for (const el of stmt.exportClause.elements) names.add(el.name.text)
    } else if (hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) {
      if (ts.isVariableStatement(stmt))
        for (const d of stmt.declarationList.declarations)
          bindingNames(d.name, []).forEach((n) => names.add(n))
      else if (
        (ts.isFunctionDeclaration(stmt) ||
          ts.isClassDeclaration(stmt) ||
          ts.isInterfaceDeclaration(stmt) ||
          ts.isTypeAliasDeclaration(stmt) ||
          ts.isEnumDeclaration(stmt)) &&
        stmt.name
      )
        names.add(stmt.name.text)
    }
  }
  return { names, stars }
}

/** Every named import of a module of the package names something the module exports. */
function checkImports(texts: Map<string, string>): string[] {
  const problems: string[] = []
  const known = new Map<string, { names: Set<string>; stars: string[] }>()
  const exportsOf = (module: string): { names: Set<string>; stars: string[] } | null => {
    if (!texts.has(module)) return null
    if (!known.has(module)) known.set(module, exportsOfText(`${module}.ts`, texts.get(module)!))
    return known.get(module)!
  }
  const has = (module: string, name: string, seen = new Set<string>()): boolean | null => {
    const found = exportsOf(module)
    if (!found || seen.has(module)) return null
    seen.add(module)
    if (found.names.has(name)) return true
    return found.stars.some((star) => {
      const target = moduleOf(star)
      return target ? has(target, name, seen) !== false : true
    })
  }
  for (const [module, text] of texts) {
    const sf = ts.createSourceFile(`${module}.ts`, text, ts.ScriptTarget.ES2022, true)
    for (const stmt of sf.statements) {
      if (!(ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) || !stmt.moduleSpecifier)
        continue
      const target = moduleOf((stmt.moduleSpecifier as ts.StringLiteral).text)
      if (!target) continue
      if (!texts.has(target)) {
        if (!existsSync(join(SRC, `${target}.ts`)))
          problems.push(`${module}: imports ${target}, which does not exist`)
        continue
      }
      const named = ts.isImportDeclaration(stmt)
        ? stmt.importClause?.namedBindings && ts.isNamedImports(stmt.importClause.namedBindings)
          ? stmt.importClause.namedBindings.elements
          : []
        : stmt.exportClause && ts.isNamedExports(stmt.exportClause)
          ? stmt.exportClause.elements
          : []
      for (const el of named) {
        const name = (el.propertyName ?? el.name).text
        if (has(target, name) === false)
          problems.push(`${module}: imports ${name} from ${target}, which does not export it`)
      }
    }
  }
  return problems
}

// ---------------------------------------------------------------- run

/** `text` as the repository's formatters write it: prettier for TypeScript, rustfmt for Rust (CI checks both). */
async function formatted(path: string, text: string): Promise<string> {
  if (path.endsWith('.rs')) {
    const rustfmt = spawnSync('rustfmt', ['--edition', '2024', '--emit', 'stdout'], {
      input: text,
      encoding: 'utf8',
    })
    if (rustfmt.status !== 0) throw new Error(`rustfmt refused ${path}: ${rustfmt.stderr}`)
    return rustfmt.stdout
  }
  return prettier.format(text, { ...(await prettier.resolveConfig(path)), filepath: path })
}

async function writeIfChanged(path: string, raw: string): Promise<boolean> {
  const text = await formatted(path, raw)
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return false
  if (!DRY) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  return true
}

const { exports: all } = build()
await writeManifest({ exports: all })
const { outputs, verbatim, dropped, wrapped } = generateModules(all)
let changed = 0
for (const out of outputs)
  if (await writeIfChanged(join(SRC, `${out.module}.ts`), out.text)) changed++
for (const module of dropped)
  if (existsSync(join(SRC, `${module}.ts`)) && !DRY) rmSync(join(SRC, `${module}.ts`))
for (const module of verbatim) {
  const text = readFileSync(join(REFERENCE, `${module}.ts`), 'utf8')
  if (await writeIfChanged(join(SRC, `${module}.ts`), text)) changed++
}
if (config.typeShapes) {
  const typeShapes: Record<string, unknown> = {}
  for (const name of config.typeShapes) {
    const shape = all.find((e) => e.kind === 'type' && e.name === name)?.ret.shape
    if (shape) typeShapes[name] = shape
  }
  const path = join(SRC, 'engine-type-shapes.ts')
  const text = `// GENERATED by tools/docx-diff/binding/gen.ts: where a Map, a Set or an array with holes sits in the model values the engine writes back.\nimport type { Shape } from '@seuoffice/engine-wasm'\n\nexport const TYPE_SHAPES: Readonly<Record<string, Shape>> = ${JSON.stringify(typeShapes)}\n`
  if (await writeIfChanged(path, text)) console.log('engine-type-shapes.ts written')
}
{
  const texts = new Map<string, string>()
  for (const module of verbatim)
    texts.set(module, readFileSync(join(REFERENCE, `${module}.ts`), 'utf8'))
  for (const out of outputs) texts.set(out.module, out.text)
  for (const module of config.plumbing)
    texts.set(module, readFileSync(join(SRC, `${module}.ts`), 'utf8'))
  if (config.shapesModule) texts.set('engine-shapes', 'export const SHAPES = {}')
  for (const problem of checkImports(texts)) console.log(`  import check: ${problem}`)
}
console.log(
  `${outputs.length} modules rewritten, ${verbatim.length} copied, ${dropped.length} dropped (${dropped.join(', ')}), ${changed} files changed${DRY ? ' (dry run)' : ''}`,
)

const shapes: Record<string, unknown> = {}
for (const e of all)
  if (e.kind === 'function' && e.ret.shape && e.route !== 'ts' && !shapes[e.name])
    shapes[e.name] = e.ret.shape
const shapesText = `// GENERATED by tools/docx-diff/binding/gen.ts: where a Map or a Set sits in what an export returns.\nimport type { Shape } from './engine'\n\nexport const SHAPES: Record<string, Shape> = ${JSON.stringify(shapes, null, 2)}\n`
if (config.shapesModule && (await writeIfChanged(join(SRC, 'engine-shapes.ts'), shapesText)))
  console.log('engine-shapes.ts written')
const table = rustTable(
  all.filter(
    (e) =>
      e.kind === 'function' &&
      (e.route === 'routes' || (e.route === 'table' && wrapped.has(e.name))),
  ),
)
if (await writeIfChanged(join(ROOT, config.table.file), table.text))
  console.log(`${config.table.module}.rs written: ${table.rows} rows`)
for (const note of table.notes) console.log(`  note: ${note}`)
