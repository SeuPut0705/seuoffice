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
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
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
// The docx engine the frozen copy and the harness call is the docx gate's
// frozen TypeScript (tools/docx-diff/reference), never the package, whose
// exports call the wasm since batch B4.
const DOCX = "'@seuoffice/docx-engine'"
const docxReference = resolve(root, 'tools/docx-diff/reference/index')
function repointDocx(file) {
  const text = readFileSync(file, 'utf8')
  if (!text.includes(DOCX)) return
  let path = relative(dirname(file), docxReference)
  if (!path.startsWith('.')) path = `./${path}`
  writeFileSync(file, text.replaceAll(DOCX, `'${path}'`))
}
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.name.endsWith('.ts')) repointDocx(path)
  }
}
walk(reference)
for (const entry of readdirSync(here)) if (entry.endsWith('.ts')) repointDocx(resolve(here, entry))
console.log(
  'odt-diff: the TypeScript engine is frozen in tools/odt-diff/reference; ts.ts points at it, and it and the harness call the frozen docx engine of tools/docx-diff/reference',
)
