// Module resolution of the render benchmark (bench-render.ts): where
// `@seuoffice/pptx-engine` and its subpaths load from.
//   BENCH_ENGINE_DIR  every import of the package goes to this folder
//                     (`.` to index.ts, `./<sub>` to <sub>.ts): the frozen
//                     TypeScript engine
//   BENCH_SHIM_DIR    `./<sub>` goes to <dir>/<sub>.mjs where that file exists:
//                     the binding with some exports taken from the reference
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PACKAGE = '@seuoffice/pptx-engine'

export async function resolve(specifier, context, next) {
  if (specifier !== PACKAGE && !specifier.startsWith(`${PACKAGE}/`)) return next(specifier, context)
  const sub = specifier === PACKAGE ? 'index' : specifier.slice(PACKAGE.length + 1)
  const shims = process.env.BENCH_SHIM_DIR
  if (shims && existsSync(join(shims, `${sub}.mjs`))) {
    return { url: pathToFileURL(join(shims, `${sub}.mjs`)).href, shortCircuit: true }
  }
  const dir = process.env.BENCH_ENGINE_DIR
  if (dir) return next(pathToFileURL(join(dir, `${sub}.ts`)).href, context)
  return next(specifier, context)
}
