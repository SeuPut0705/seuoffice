// Saves a received ODT with nothing changed the way the Word editor does: open through the
// public bridge (odtToDocx), save the bridge docx with every block kept as original, write back
// with saveOdt. The CLI only writes after an op, so this is the plain "open and save" path.
//
//   node node_modules/tsx/dist/cli.mjs tools/odt-hancom/save-unedited.mts <in.odt> <out.odt>
//
// Prints one JSON line: { status: "ok", sameBytes }.
import { readFileSync, writeFileSync } from 'node:fs'
import { type SaveBlock, parseDocx, saveDocx } from '@genoffice/docx-engine'
import { odtToDocx, saveOdt } from '@genoffice/odt-engine'

const [input, output] = process.argv.slice(2)
if (!input || !output) {
  console.error('usage: save-unedited.mts <in.odt> <out.odt>')
  process.exit(1)
}
const originalOdt = new Uint8Array(readFileSync(input))
const { docxBytes, bridge } = await odtToDocx(originalOdt)
const parsed = await parseDocx(docxBytes)
const save: SaveBlock[] = parsed.blocks
  .filter((b) => !b.hidden)
  .map((b) => ({ kind: 'original', docxIndex: b.docxIndex as number }))
const editedDocx = await saveDocx(parsed, save)
const saved = await saveOdt({ originalOdt, bridge, editedDocx })
writeFileSync(output, saved)
const sameBytes = saved.length === originalOdt.length && saved.every((v, i) => v === originalOdt[i])
console.log(JSON.stringify({ status: 'ok', sameBytes }))
