/**
 * Statements of an entry module that cannot be imported (importing
 * `apps/shell/src/main/index.ts` starts the whole app): each is found in the
 * module's source with the TypeScript parser by how it starts, exactly once,
 * stripped of types, and run over the names the group gives it. The group
 * thereby runs the entry's own handler code, not a copy.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(fileURLToPath(import.meta.url), '../../../../../..')

/** The JavaScript of the statements of `entry` (from the repository root) that start as listed */
export function entryStatements(entry: string, starts: readonly string[]): string {
  const path = resolve(root, entry)
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const found = new Map<string, string[]>(starts.map((s) => [s, []]))
  const visit = (node: ts.Node): void => {
    if (
      ts.isExpressionStatement(node) ||
      ts.isVariableStatement(node) ||
      ts.isFunctionDeclaration(node)
    ) {
      const text = node.getText(file)
      for (const start of starts) if (text.startsWith(start)) found.get(start)!.push(text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  const source = starts
    .map((start) => {
      const texts = found.get(start)!
      if (texts.length !== 1) {
        throw new Error(`${entry}: ${texts.length} statements start with ${start}`)
      }
      return texts[0]
    })
    .join('\n')
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
    .outputText
}

/** Runs `code` with `names` in scope */
export function runWith(code: string, names: Record<string, unknown>): void {
  new Function(...Object.keys(names), code)(...Object.values(names))
}
