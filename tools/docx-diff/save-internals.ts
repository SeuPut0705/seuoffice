// patch.ts exports few of its functions. To compare the others one by one
// (group `save` of comparison (f)), this writes a copy of the module to
// out/save-internals.ts in which every top-level function and constant is
// exported. The copy is the same code: only `export ` is added, and the
// relative imports point back at tools/docx-diff/reference.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { repoRoot, toolDir } from './harness'

const SOURCE = resolve(repoRoot, 'tools/docx-diff/reference/patch.ts')
const COPY = resolve(toolDir, 'out/save-internals.ts')

function writeCopy(): void {
  const text = readFileSync(SOURCE, 'utf8')
  const source = ts.createSourceFile(SOURCE, text, ts.ScriptTarget.Latest, true)
  const edits: Array<{ at: number; insert: string; drop?: number }> = []
  const exported = (statement: ts.Statement): boolean =>
    !!ts
      .getModifiers(statement as ts.HasModifiers)
      ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  const back = relative(resolve(toolDir, 'out'), resolve(SOURCE, '..')).replaceAll('\\', '/')
  for (const statement of source.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier
    ) {
      const specifier = statement.moduleSpecifier as ts.StringLiteral
      if (specifier.text.startsWith('./')) {
        // './x' becomes '<back>/x'
        edits.push({ at: specifier.getStart(source) + 1, insert: `${back}/`, drop: 2 })
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      if (!exported(statement)) edits.push({ at: statement.getStart(source), insert: 'export ' })
    } else if (ts.isVariableStatement(statement) && !exported(statement)) {
      edits.push({ at: statement.getStart(source), insert: 'export ' })
    }
  }
  let out = text
  for (const edit of edits.sort((a, b) => b.at - a.at)) {
    out = out.slice(0, edit.at) + edit.insert + out.slice(edit.at + (edit.drop ?? 0))
  }
  mkdirSync(resolve(toolDir, 'out'), { recursive: true })
  writeFileSync(
    COPY,
    `// Written by tools/docx-diff/save-internals.ts from ${relative(repoRoot, SOURCE).replaceAll('\\', '/')}: do not edit.\n${out}`,
  )
}

/** A function of the copy: its parameters are what the spec passes. */
type Internals = Record<string, (...args: unknown[]) => unknown>

let loaded: Promise<Internals> | null = null

/** Every top-level function of patch.ts, by name. */
export function saveInternals(): Promise<Internals> {
  loaded ??= (async () => {
    writeCopy()
    // the copy is written just above, at run time: no static import can name it
    return (await import(pathToFileURL(COPY).href)) as Internals
  })()
  return loaded
}
