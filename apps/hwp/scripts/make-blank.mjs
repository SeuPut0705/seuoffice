/**
 * Writes the document a new HWP tab starts from (src/renderer/assets/blank.hwp): the rhwp
 * engine's own blank document, one empty paragraph on an A4 page. Run it again after
 * updating @rhwp/core; tests/blank-document.test.ts checks what the file holds.
 *
 *   node scripts/make-blank.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(APP, 'package.json'))
const corePath = require.resolve('@rhwp/core')
const { default: init, HwpDocument } = await import(pathToFileURL(corePath).href)
await init({ module_or_path: readFileSync(join(dirname(corePath), 'rhwp_bg.wasm')) })

const doc = HwpDocument.createEmpty()
doc.createBlankDocument()
const bytes = doc.exportHwp()
doc.free()
const out = join(APP, 'src', 'renderer', 'assets', 'blank.hwp')
writeFileSync(out, bytes)
console.log(`wrote ${out} (${bytes.length} bytes)`)
