// parse.ts exports 12 of its 154 functions. To compare the others one by one
// (comparison (f), leaf first), this writes a copy of the module to
// out/parse-internals.ts in which every top-level function is exported and
// every function declaration first reports its arguments to `captureHook`.
// The copy is the same code: only `export ` and that one statement are added,
// and the relative imports point back at tools/docx-diff/reference.
//
// `parseInternals()` imports the copy. `captureCalls(run)` runs `run` with a
// sink installed, so that a parseDocx of the copy over one corpus document
// yields the arguments each internal function was called with there.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { repoRoot, toolDir } from './harness'

export type Captured = (fn: string, args: unknown[]) => void

let sink: Captured | null = null

/** Called by the copy, first thing in every function declaration. */
export function captureHook(fn: string, args: ArrayLike<unknown>): void {
  if (sink) sink(fn, Array.from(args))
}

/** `run` with `capture` receiving every internal call, in call order. */
export async function captureCalls<T>(capture: Captured, run: () => Promise<T>): Promise<T> {
  if (sink) throw new Error('captureCalls does not nest')
  sink = capture
  try {
    return await run()
  } finally {
    sink = null
  }
}

const SOURCE = resolve(repoRoot, 'tools/docx-diff/reference/parse.ts')
const COPY = resolve(toolDir, 'out/parse-internals.ts')

function writeCopy(): void {
  const text = readFileSync(SOURCE, 'utf8')
  const source = ts.createSourceFile(SOURCE, text, ts.ScriptTarget.Latest, true)
  const edits: Array<{ at: number; insert: string }> = []
  const exported = (statement: ts.Statement): boolean =>
    !!ts.getModifiers(statement as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  const back = relative(resolve(toolDir, 'out'), resolve(SOURCE, '..')).replaceAll('\\', '/')
  for (const statement of source.statements) {
    if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier) {
      const specifier = statement.moduleSpecifier as ts.StringLiteral
      if (specifier.text.startsWith('.')) {
        edits.push({ at: specifier.getStart(source) + 1, insert: `${back}/` })
        // drop the leading './' of the specifier itself
        if (specifier.text.startsWith('./')) edits.push({ at: -(specifier.getStart(source) + 1), insert: '' })
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      if (!exported(statement)) edits.push({ at: statement.getStart(source), insert: 'export ' })
      edits.push({
        at: statement.body.getStart(source) + 1,
        insert: `captureHook(${JSON.stringify(statement.name.text)}, arguments);`,
      })
    } else if (ts.isVariableStatement(statement) && !exported(statement)) {
      edits.push({ at: statement.getStart(source), insert: 'export ' })
    }
  }
  // a negative position removes the two characters './' there
  let out = text
  for (const edit of edits.sort((a, b) => Math.abs(b.at) - Math.abs(a.at) || a.at - b.at)) {
    out = edit.at < 0 ? out.slice(0, -edit.at) + out.slice(-edit.at + 2) : out.slice(0, edit.at) + edit.insert + out.slice(edit.at)
  }
  const hook = relative(resolve(toolDir, 'out'), resolve(toolDir, 'parse-internals')).replaceAll('\\', '/')
  out = `import { captureHook } from '${hook}'\n${out}`
  mkdirSync(resolve(toolDir, 'out'), { recursive: true })
  writeFileSync(COPY, `// Written by tools/docx-diff/parse-internals.ts from ${relative(repoRoot, SOURCE).replaceAll('\\', '/')}: do not edit.\n${out}`)
}

/** A function of the copy: its parameters are what the spec passes. */
type Internals = Record<string, (...args: unknown[]) => unknown>

let loaded: Promise<Internals> | null = null

/** Every top-level function of parse.ts, by name. */
export function parseInternals(): Promise<Internals> {
  loaded ??= (async () => {
    writeCopy()
    // the copy is written just above, at run time: no static import can name it
    return (await import(pathToFileURL(COPY).href)) as Internals
  })()
  return loaded
}
