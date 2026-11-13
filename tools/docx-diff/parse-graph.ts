// The top-level functions of a TypeScript module, the module's own functions
// each one calls, and the waves of a leaf-first port: wave 0 calls none of
// them, wave n only those of earlier waves. A cycle is one wave of its own.
//
//   npx tsx tools/docx-diff/parse-graph.ts [MODULE.ts] [--json OUT]
//
// The default module is tools/docx-diff/reference/parse.ts. A function counts
// as ported when a `/// \`name\`` doc comment in crates/ names it.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { repoRoot } from './harness'

interface Fn {
  name: string
  start: number
  end: number
  exported: boolean
  async: boolean
  calls: string[]
  imports: string[]
  ported: string | null
}

const args = process.argv.slice(2)
const jsonAt = args.indexOf('--json')
const out = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : undefined
const path = resolve(repoRoot, args[0] ?? 'tools/docx-diff/reference/parse.ts')
const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
const line = (pos: number): number => source.getLineAndCharacterOfPosition(pos).line + 1

const imported = new Map<string, string>()
for (const statement of source.statements) {
  if (!ts.isImportDeclaration(statement) || !statement.importClause) continue
  const from = (statement.moduleSpecifier as ts.StringLiteral).text
  const bindings = statement.importClause.namedBindings
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) imported.set(element.name.text, from)
  }
  if (statement.importClause.name) imported.set(statement.importClause.name.text, from)
}

// top-level functions and arrow functions held in a const
const bodies = new Map<string, { node: ts.Node; exported: boolean; async: boolean }>()
for (const statement of source.statements) {
  const exported = !!ts
    .getModifiers(statement as ts.HasModifiers)
    ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  if (ts.isFunctionDeclaration(statement) && statement.name) {
    const async = !!statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
    bodies.set(statement.name.text, { node: statement, exported, async })
  } else if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      const init = declaration.initializer
      if (
        ts.isIdentifier(declaration.name) &&
        init &&
        (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
      ) {
        const async = !!init.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
        bodies.set(declaration.name.text, { node: statement, exported, async })
      }
    }
  }
}

const ported = new Map<string, string>()
const walk = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const at = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'target' && entry.name !== 'vendor') walk(at)
    } else if (entry.name.endsWith('.rs')) {
      const text = readFileSync(at, 'utf8')
      for (const found of text.matchAll(/^\s*\/\/\/ `([A-Za-z_$][\w$]*)`/gm)) {
        if (!ported.has(found[1]!))
          ported.set(
            found[1]!,
            `${relative(repoRoot, at).replaceAll('\\', '/')}:${text.slice(0, found.index).split('\n').length}`,
          )
      }
    }
  }
}
walk(resolve(repoRoot, 'crates'))

const fns: Fn[] = []
for (const [name, { node, exported, async }] of bodies) {
  const calls = new Set<string>()
  const imports = new Set<string>()
  const visit = (child: ts.Node): void => {
    if (ts.isIdentifier(child) && child !== (node as ts.FunctionDeclaration).name) {
      const parent = child.parent
      const isPropertyName =
        parent && ts.isPropertyAccessExpression(parent) && parent.name === child
      if (!isPropertyName) {
        if (bodies.has(child.text) && child.text !== name) calls.add(child.text)
        const from = imported.get(child.text)
        if (from) imports.add(`${from}#${child.text}`)
      }
    }
    ts.forEachChild(child, visit)
  }
  ts.forEachChild(node, visit)
  fns.push({
    name,
    start: line(node.getStart(source)),
    end: line(node.end),
    exported,
    async,
    calls: [...calls].sort(),
    imports: [...imports].sort(),
    ported: ported.get(name) ?? null,
  })
}

// waves over the strongly connected components (Tarjan)
const byName = new Map(fns.map((fn) => [fn.name, fn]))
const index = new Map<string, number>()
const low = new Map<string, number>()
const stack: string[] = []
const onStack = new Set<string>()
const component = new Map<string, number>()
const components: string[][] = []
let counter = 0
const connect = (name: string): void => {
  index.set(name, counter)
  low.set(name, counter++)
  stack.push(name)
  onStack.add(name)
  for (const callee of byName.get(name)!.calls) {
    if (!index.has(callee)) {
      connect(callee)
      low.set(name, Math.min(low.get(name)!, low.get(callee)!))
    } else if (onStack.has(callee)) low.set(name, Math.min(low.get(name)!, index.get(callee)!))
  }
  if (low.get(name) === index.get(name)) {
    const members: string[] = []
    let member: string
    do {
      member = stack.pop()!
      onStack.delete(member)
      component.set(member, components.length)
      members.push(member)
    } while (member !== name)
    components.push(members)
  }
}
for (const fn of fns) if (!index.has(fn.name)) connect(fn.name)
// Tarjan emits components callees first
const waveOf = new Map<number, number>()
components.forEach((members, at) => {
  let wave = 0
  for (const member of members) {
    for (const callee of byName.get(member)!.calls) {
      const other = component.get(callee)!
      if (other !== at) wave = Math.max(wave, waveOf.get(other)! + 1)
    }
  }
  waveOf.set(at, wave)
})

const waves: Array<Array<Fn & { cycle: number }>> = []
for (const fn of fns) {
  const at = component.get(fn.name)!
  const wave = waveOf.get(at)!
  ;(waves[wave] ??= []).push({ ...fn, cycle: components[at]!.length > 1 ? at : -1 })
}
let total = 0
waves.forEach((members, wave) => {
  members.sort((a, b) => a.start - b.start)
  const lines = members.reduce((sum, fn) => sum + fn.end - fn.start + 1, 0)
  const done = members.filter((fn) => fn.ported).length
  total += lines
  console.log(`wave ${wave}: ${members.length} functions, ${lines} lines, ${done} ported`)
  for (const fn of members) {
    const flags = [
      fn.exported ? 'export' : '',
      fn.async ? 'async' : '',
      fn.cycle >= 0 ? `cycle${fn.cycle}` : '',
      fn.ported ? `ported ${fn.ported}` : '',
    ]
      .filter(Boolean)
      .join(' ')
    console.log(
      `  ${fn.name} ${fn.start}-${fn.end} (${fn.end - fn.start + 1})${flags ? ' ' + flags : ''}${fn.calls.length ? ' -> ' + fn.calls.join(', ') : ''}`,
    )
  }
})
console.log(`${fns.length} functions, ${total} lines in functions`)
if (out) writeFileSync(out, JSON.stringify(waves, null, 1) + '\n')
