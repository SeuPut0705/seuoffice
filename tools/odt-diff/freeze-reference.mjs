// The switch of packages/odt-engine to the Rust engine: its exports now call the
// wasm, so the TypeScript the gate compares against would no longer be there.
// This freezes it: it copies the sources of packages/odt-engine and the test
// helpers the corpus is built from into tools/odt-diff/reference/, and
// repoints ts.ts at the copy. Run it once, at the switch, before the package's
// exports change (it is not run by the gate):
//
//   node tools/odt-diff/freeze-reference.mjs
//
// The copy keeps the layout the helpers import by (`../../src/...`):
//
//   reference/src/            <- packages/odt-engine/src
//   reference/tests/helpers/  <- packages/odt-engine/tests/helpers
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const source = resolve(root, 'packages/odt-engine')
const reference = resolve(here, 'reference')
const tsPath = resolve(here, 'ts.ts')

const SRC = '../../packages/odt-engine/src'
const HELPERS = '../../packages/odt-engine/tests/helpers'

const text = readFileSync(tsPath, 'utf8')
if (!text.includes(SRC) || !text.includes(HELPERS)) {
  console.error('ts.ts no longer points at packages/odt-engine: already frozen?')
  process.exit(1)
}
if (existsSync(reference)) rmSync(reference, { recursive: true })
mkdirSync(resolve(reference, 'tests'), { recursive: true })
cpSync(resolve(source, 'src'), resolve(reference, 'src'), { recursive: true })
cpSync(resolve(source, 'tests/helpers'), resolve(reference, 'tests/helpers'), { recursive: true })
writeFileSync(
  tsPath,
  text.replaceAll(SRC, './reference/src').replaceAll(HELPERS, './reference/tests/helpers'),
)
console.log(
  'odt-diff: the TypeScript engine is frozen in tools/odt-diff/reference; ts.ts points at it',
)
