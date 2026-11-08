// Replaces one picture of a received ODT the way the Word editor's "change picture" saves it:
// open through the public bridge (odtToDocx), save the bridge docx with the picture block's
// bytes swapped (docx engine `replaceImage`, every other block kept as original), write back
// with saveOdt. The CLI has no op for this, so it goes through the engines' public APIs.
//
//   node node_modules/tsx/dist/cli.mjs tools/odt-hancom/replace-picture.mts <in.odt> <out.odt> <picture.png>
//
// Prints one JSON line: { status: "ok", block, name } or { status: "skip", reason }.
import { readFileSync, writeFileSync } from 'node:fs'
import { type SaveBlock, parseDocx, saveDocx } from '@genoffice/docx-engine'
import { odtToDocx, saveOdt } from '@genoffice/odt-engine'

const [input, output, picture] = process.argv.slice(2)
if (!input || !output || !picture) {
  console.error('usage: replace-picture.mts <in.odt> <out.odt> <picture.png>')
  process.exit(1)
}

const originalOdt = new Uint8Array(readFileSync(input))
const { docxBytes, bridge } = await odtToDocx(originalOdt)
const parsed = await parseDocx(docxBytes)
const blocks = parsed.blocks.filter((b) => !b.hidden)
// a body-level block (not a table: a picture in a cell is saved through the table path)
const target = blocks.findIndex(
  (b) =>
    b.type !== 'table' && typeof b.originalXml === 'string' && /name="odt-pic:/.test(b.originalXml),
)
if (target < 0) {
  console.log(JSON.stringify({ status: 'skip', reason: 'no editable picture outside tables' }))
  process.exit(0)
}
const base64 = Buffer.from(readFileSync(picture)).toString('base64')
const save: SaveBlock[] = blocks.map((b, i) =>
  i === target
    ? {
        kind: 'xml',
        xml: b.originalXml as string,
        docxIndex: b.docxIndex as number,
        replaceImage: { base64, mime: 'image/png' },
      }
    : { kind: 'original', docxIndex: b.docxIndex as number },
)
const editedDocx = await saveDocx(parsed, save)
const odt = await saveOdt({ originalOdt, bridge, editedDocx })
writeFileSync(output, odt)
const name = /name="(odt-pic:[^"]+)"/.exec(blocks[target]!.originalXml as string)?.[1]
console.log(JSON.stringify({ status: 'ok', block: target, name }))
