import { readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sourceRoot = resolve(root, 'tools/pptx-diff/reference')
const paths = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name))
  .map((entry) => resolve(entry.parentPath, entry.name))
  .sort()
const known = new Set(paths)
const modules = paths.map((path) => {
  const text = readFileSync(path, 'utf8')
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const imports = []
  for (const node of source.statements) {
    if ((!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) || !node.moduleSpecifier)
      continue
    const specifier = node.moduleSpecifier.text
    const clause = ts.isImportDeclaration(node) ? node.importClause : undefined
    const bindings =
      clause?.namedBindings ?? (ts.isExportDeclaration(node) ? node.exportClause : undefined)
    const typeOnly = Boolean(
      node.isTypeOnly ||
      clause?.isTypeOnly ||
      (bindings &&
        (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) &&
        !clause?.name &&
        bindings.elements.length > 0 &&
        bindings.elements.every((binding) => binding.isTypeOnly)),
    )
    const base = resolve(dirname(path), specifier)
    const target = specifier.startsWith('.')
      ? [base, base + '.ts', resolve(base, 'index.ts'), base.replace(/\.js$/, '.ts')].find(
          (candidate) => known.has(candidate),
        )
      : undefined
    imports.push({
      source: specifier,
      ...(target ? { module: relative(sourceRoot, target).replaceAll('\\', '/') } : {}),
      typeOnly,
    })
  }
  return {
    module: relative(sourceRoot, path).replaceAll('\\', '/'),
    lines: text.split('\n').length - Number(text.endsWith('\n')),
    imports,
  }
})
console.log(
  JSON.stringify(
    {
      files: modules.length,
      lines: modules.reduce((sum, module) => sum + module.lines, 0),
      modules,
    },
    null,
    2,
  ),
)
