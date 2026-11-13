/**
 * The import suffixes electron-vite resolves at build time, for main-process
 * modules loaded as source: `?asset` and `?modulePath` give the file's path,
 * `?raw` its text. Without these a module that imports an icon cannot load.
 *
 * The apps compile to CommonJS under tsx, whose own `require` resolver drops
 * the query of a specifier, so a suffixed `require` is answered before it
 * resolves; `import` goes through a module hook.
 */
import { readFileSync } from 'node:fs'
import Module, { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const SUFFIX = /\?(asset|raw|modulePath)$/

const valueOf = (path: string, kind: string): string =>
  kind === 'raw' ? readFileSync(path, 'utf8') : path

const cjs = Module as unknown as {
  _resolveFilename(request: string, parent: unknown): string
  prototype: { require(this: unknown, request: string): unknown }
}
const require = cjs.prototype.require
cjs.prototype.require = function (request: string): unknown {
  const m = SUFFIX.exec(request)
  if (!m) return require.call(this, request)
  const path = cjs._resolveFilename(request.slice(0, m.index), this)
  return { __esModule: true, default: valueOf(path, m[1]) }
}

registerHooks({
  resolve(specifier, context, next) {
    const m = SUFFIX.exec(specifier)
    if (!m) return next(specifier, context)
    const file = next(specifier.slice(0, m.index), context).url
    return { url: `${file}?vite=${m[1]}`, shortCircuit: true }
  },
  load(url, context, next) {
    const m = /\?vite=(asset|raw|modulePath)$/.exec(url)
    if (!m) return next(url, context)
    const value = valueOf(fileURLToPath(url.slice(0, m.index)), m[1])
    return {
      format: 'module',
      source: `export default ${JSON.stringify(value)}`,
      shortCircuit: true,
    }
  },
})
