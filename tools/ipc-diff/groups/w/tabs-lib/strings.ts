/**
 * The Korean strings of the shell's own catalog (`tm(key)` of
 * `apps/shell/src/main/index.ts`, the `ko` table of its `createI18n` call),
 * read from the source with the TypeScript compiler. The Rust fakes answer
 * `tm` from this table, so a menu label is the one the person would see.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ENTRY = resolve(fileURLToPath(import.meta.url), '../../../../../../apps/shell/src/main/index.ts')

let cached: Record<string, string> | undefined

export function koStrings(): Record<string, string> {
  if (cached) return cached
  const source = ts.createSourceFile(ENTRY, readFileSync(ENTRY, 'utf8'), ts.ScriptTarget.Latest, true)
  const out: Record<string, string> = {}
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'createI18n' &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      for (const table of node.arguments[0].properties) {
        if (
          !ts.isPropertyAssignment(table) ||
          table.name.getText(source) !== 'ko' ||
          !ts.isObjectLiteralExpression(table.initializer)
        ) {
          continue
        }
        for (const entry of table.initializer.properties) {
          if (!ts.isPropertyAssignment(entry)) continue
          const init = entry.initializer
          if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
            out[entry.name.getText(source).replace(/^['"]|['"]$/g, '')] = init.text
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  cached = out
  return out
}
